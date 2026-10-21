"""Switch Codex's provider index without rewriting conversation bytes or offsets.

Input/output is private JSON over pipes; never print config contents or tokens.
Only config.toml and threads.model_provider are changed. SQLite's backup API
includes WAL state, while rollback restores only our columns, never newer chats.
"""
import base64
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import tempfile
import uuid


def emit(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


def atomic_write(path, data, mode=0o600):
    fd, temporary = tempfile.mkstemp(prefix=".agent-center-", dir=str(path.parent))
    try:
        os.chmod(temporary, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def connect(path):
    # URI quoting matters for paths containing spaces, '?' and '#'.
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=rw", uri=True, timeout=10)
    connection.execute("PRAGMA busy_timeout=10000")
    columns = {row[1] for row in connection.execute("PRAGMA table_info(threads)")}
    if not {"id", "model_provider"}.issubset(columns):
        connection.close()
        raise ValueError("发现不兼容的 Codex 历史数据库，已停止切换；请先更新 Codex。")
    return connection


def switch(request):
    home = Path(request["home"]).expanduser().resolve()
    provider = request["provider"]
    if not isinstance(provider, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", provider):
        raise ValueError("无效的服务商 ID。")
    expected = base64.b64decode(request["expectedConfig"], validate=True)
    next_config = base64.b64decode(request["nextConfig"], validate=True)
    home.mkdir(parents=True, exist_ok=True)
    config = (home / "config.toml").resolve()
    config_existed = config.exists()
    original = config.read_bytes() if config_existed else b""
    if original != expected:
        raise ValueError("Codex 配置刚刚发生变化，请重新选择服务商。")
    mode = 0o600  # Configs can contain API keys; do not keep world-readable modes.
    state = home / "agent-center"
    state.mkdir(mode=0o700, exist_ok=True)
    os.chmod(state, 0o700)
    lock = state / "provider-switch.lock"
    try:
        lock_fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise ValueError("已有服务商切换正在进行。若上次进程异常退出，请先确认没有切换任务，再移除 agent-center/provider-switch.lock。")
    with os.fdopen(lock_fd, "w") as stream:
        stream.write(str(os.getpid()))
    connections = []
    mappings = []
    backup = None
    config_written = False
    committed = []
    try:
        paths = sorted(set(home.glob("state_*.sqlite")) | set(home.glob("state.sqlite")))
        if not paths and any(any((home / folder).rglob("*.jsonl")) for folder in ("sessions", "archived_sessions")):
            raise ValueError("存在历史文件但未找到兼容的历史索引。请先启动或更新 Codex，生成索引后再切换。")
        for path in paths:
            connections.append((path, connect(path)))
        emit({"progress": "正在备份配置与历史索引…"})
        backup_root = state / "provider-backups"
        backup_root.mkdir(mode=0o700, exist_ok=True)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup = backup_root / (stamp + "-" + uuid.uuid4().hex[:10])
        backup.mkdir(mode=0o700)
        atomic_write(backup / "config.toml", original)
        for path, connection in connections:
            target = backup / path.name
            with sqlite3.connect(str(target)) as destination:
                connection.backup(destination)
            os.chmod(target, 0o600)
        # Lock all indexes before reading the exact values used for rollback.
        all_ids = set()
        changed_ids = set()
        for path, connection in connections:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute("SELECT id, model_provider FROM threads").fetchall()
            mappings.append((path, rows))
            all_ids.update(row[0] for row in rows)
            changed_ids.update(row[0] for row in rows if row[1] != provider)
        atomic_write(backup / "provider-mapping.json", json.dumps({
            "provider": provider, "configExisted": config_existed,
            "databases": {path.name: rows for path, rows in mappings},
        }, ensure_ascii=True).encode("utf-8"))
        emit({"progress": "正在让全部历史对当前服务商可见…"})
        # No rollout JSONL, paginated-history offsets, auth files, timestamps,
        # titles, archive flags or conversation contents are rewritten.
        for _, connection in connections:
            connection.execute("UPDATE threads SET model_provider = ? WHERE model_provider IS NOT ?", (provider, provider))
        if (config.read_bytes() if config.exists() else b"") != expected:
            raise ValueError("Codex 配置刚刚发生变化，已取消切换。")
        atomic_write(config, next_config, mode)
        config_written = True
        for path, connection in connections:
            connection.commit()
            committed.append(path)
        atomic_write(backup / "complete.json", json.dumps({"provider": provider}).encode())
        # Bound automatic backups to the latest five successful switches.
        successful = sorted((p for p in backup_root.iterdir() if p.is_dir() and not p.is_symlink() and (p / "complete.json").exists()),
                            key=lambda p: ((p / "complete.json").stat().st_mtime_ns, p == backup))
        for old in successful[:-5]:
            if old.resolve().parent == backup_root.resolve():
                try:
                    shutil.rmtree(str(old))
                except OSError:
                    pass
        return {"ok": True, "provider": provider, "threadCount": len(all_ids),
                "changedCount": len(changed_ids), "databaseCount": len(connections),
                "backupDirectory": str(backup)}
    except BaseException as error:
        for _, connection in connections:
            if connection.in_transaction:
                connection.rollback()
        rollback_failed = False
        for path, rows in mappings:
            if path not in committed:
                continue
            try:
                connection = next(c for p, c in connections if p == path)
                with connection:
                    connection.executemany("UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider = ?",
                                           [(old, thread_id, provider) for thread_id, old in rows])
            except Exception:
                rollback_failed = True
        if config_written:
            try:
                # Respect edits made by another process after our write.
                if config.read_bytes() == next_config:
                    if config_existed:
                        atomic_write(config, original)
                    else:
                        config.unlink()
                else:
                    rollback_failed = True
            except Exception:
                rollback_failed = True
        message = str(error) if isinstance(error, ValueError) else "服务商切换失败，可能是数据库正在使用或文件无法写入。"
        if rollback_failed:
            message += " 自动恢复未全部完成，请使用备份恢复后重试。"
        emit({"ok": False, "error": message, "backupDirectory": str(backup) if backup else ""})
        return None
    finally:
        for _, connection in connections:
            connection.close()
        lock.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        result = switch(json.load(sys.stdin))
        if result:
            emit(result)
        else:
            sys.exit(1)
    except Exception as error:
        emit({"ok": False, "error": str(error) if isinstance(error, ValueError) else "无法读取 Codex 配置或历史索引，未完成切换。"})
        sys.exit(1)
