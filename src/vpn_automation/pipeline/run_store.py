import sqlite3
from pathlib import Path


DEFAULT_STAGES = [
    "doctor",
    "extract",
    "dedupe",
    "speedtest",
    "availability",
    "postprocess",
    "render",
    "obfuscate",
    "deploy",
    "verify",
]


class RunStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def initialize(self, *, artifact_dir: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.path) as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS runs (
                    run_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    artifact_dir TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'running'
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS stage_events (
                    stage_name TEXT NOT NULL,
                    status TEXT NOT NULL,
                    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS source_progress (
                    source_name TEXT PRIMARY KEY,
                    iteration INTEGER NOT NULL,
                    max_iterations INTEGER NOT NULL,
                    new_links INTEGER NOT NULL,
                    raw_links INTEGER NOT NULL,
                    successful_iterations INTEGER NOT NULL,
                    failed_iterations INTEGER NOT NULL,
                    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS raw_links (
                    source_name TEXT NOT NULL,
                    link TEXT NOT NULL,
                    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(source_name, link)
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS extract_attempts (
                    source_name TEXT NOT NULL,
                    iteration INTEGER NOT NULL,
                    url TEXT NOT NULL,
                    used_proxy INTEGER NOT NULL,
                    success INTEGER NOT NULL,
                    http_status INTEGER NOT NULL,
                    error_type TEXT NOT NULL,
                    error_message TEXT NOT NULL,
                    returned_links INTEGER NOT NULL,
                    new_links INTEGER NOT NULL,
                    total_links INTEGER NOT NULL,
                    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS speedtest_results (
                    link TEXT PRIMARY KEY,
                    reachable INTEGER NOT NULL,
                    latency_ms REAL NOT NULL,
                    average_download_mb_s REAL NOT NULL,
                    error TEXT NOT NULL DEFAULT '',
                    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS availability_results (
                    link TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    passed INTEGER NOT NULL,
                    reason TEXT NOT NULL,
                    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS final_links (
                    stage_name TEXT NOT NULL,
                    link TEXT NOT NULL,
                    country_code TEXT NOT NULL DEFAULT '',
                    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            connection.execute(
                "INSERT INTO runs (artifact_dir, status) VALUES (?, ?)",
                (artifact_dir, "running"),
            )

    def record_source_progress(
        self,
        *,
        source_name: str,
        iteration: int,
        max_iterations: int,
        new_links: int,
        raw_links: int,
        successful_iterations: int,
        failed_iterations: int,
    ) -> None:
        with sqlite3.connect(self.path) as connection:
            connection.execute(
                """
                INSERT INTO source_progress (
                    source_name,
                    iteration,
                    max_iterations,
                    new_links,
                    raw_links,
                    successful_iterations,
                    failed_iterations
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_name) DO UPDATE SET
                    iteration=excluded.iteration,
                    max_iterations=excluded.max_iterations,
                    new_links=excluded.new_links,
                    raw_links=excluded.raw_links,
                    successful_iterations=excluded.successful_iterations,
                    failed_iterations=excluded.failed_iterations,
                    recorded_at=CURRENT_TIMESTAMP
                """,
                (
                    source_name,
                    iteration,
                    max_iterations,
                    new_links,
                    raw_links,
                    successful_iterations,
                    failed_iterations,
                ),
            )

    def record_stage_event(self, stage_name: str, status: str) -> None:
        with sqlite3.connect(self.path) as connection:
            connection.execute(
                "INSERT INTO stage_events (stage_name, status) VALUES (?, ?)",
                (stage_name, status),
            )

    def record_raw_link(self, source_name: str, link: str) -> None:
        with sqlite3.connect(self.path) as connection:
            connection.execute(
                "INSERT OR IGNORE INTO raw_links (source_name, link) VALUES (?, ?)",
                (source_name, link),
            )

    def record_extract_attempt(
        self,
        *,
        source_name: str,
        iteration: int,
        url: str,
        used_proxy: bool,
        success: bool,
        http_status: int,
        error_type: str,
        error_message: str,
        returned_links: int,
        new_links: int,
        total_links: int,
    ) -> None:
        with sqlite3.connect(self.path) as connection:
            connection.execute(
                """
                INSERT INTO extract_attempts (
                    source_name,
                    iteration,
                    url,
                    used_proxy,
                    success,
                    http_status,
                    error_type,
                    error_message,
                    returned_links,
                    new_links,
                    total_links
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    source_name,
                    iteration,
                    url,
                    int(used_proxy),
                    int(success),
                    http_status,
                    error_type,
                    error_message,
                    returned_links,
                    new_links,
                    total_links,
                ),
            )

    def record_speedtest_result(
        self,
        *,
        link: str,
        reachable: bool,
        latency_ms: float,
        average_download_mb_s: float,
        error: str = "",
    ) -> None:
        with sqlite3.connect(self.path) as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO speedtest_results (
                    link,
                    reachable,
                    latency_ms,
                    average_download_mb_s,
                    error
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    link,
                    int(reachable),
                    latency_ms,
                    average_download_mb_s,
                    error,
                ),
            )

    def record_availability_result(
        self,
        *,
        link: str,
        provider: str,
        passed: bool,
        reason: str,
    ) -> None:
        with sqlite3.connect(self.path) as connection:
            connection.execute(
                """
                INSERT INTO availability_results (link, provider, passed, reason)
                VALUES (?, ?, ?, ?)
                """,
                (link, provider, int(passed), reason),
            )

    def record_final_link(self, *, stage_name: str, link: str, country_code: str) -> None:
        with sqlite3.connect(self.path) as connection:
            connection.execute(
                """
                INSERT INTO final_links (stage_name, link, country_code)
                VALUES (?, ?, ?)
                """,
                (stage_name, link, country_code),
            )

    def fetch_recent_extract_attempts(self, limit: int = 20) -> list[dict[str, object]]:
        with sqlite3.connect(self.path) as connection:
            rows = connection.execute(
                """
                SELECT source_name, iteration, url, used_proxy, success, http_status,
                       error_type, error_message, returned_links, new_links, total_links
                FROM extract_attempts
                ORDER BY rowid DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [
            {
                "source_name": source_name,
                "iteration": iteration,
                "url": url,
                "used_proxy": bool(used_proxy),
                "success": bool(success),
                "http_status": http_status,
                "error_type": error_type,
                "error_message": error_message,
                "returned_links": returned_links,
                "new_links": new_links,
                "total_links": total_links,
            }
            for (
                source_name,
                iteration,
                url,
                used_proxy,
                success,
                http_status,
                error_type,
                error_message,
                returned_links,
                new_links,
                total_links,
            ) in reversed(rows)
        ]

    def fetch_source_resume_state(self, source_name: str) -> dict[str, object]:
        with sqlite3.connect(self.path) as connection:
            progress = connection.execute(
                """
                SELECT iteration, max_iterations, new_links, raw_links,
                       successful_iterations, failed_iterations
                FROM source_progress
                WHERE source_name = ?
                """,
                (source_name,),
            ).fetchone()
            raw_links = [
                row[0]
                for row in connection.execute(
                    "SELECT link FROM raw_links WHERE source_name = ? ORDER BY rowid ASC",
                    (source_name,),
                ).fetchall()
            ]
        if not progress:
            return {
                "iteration": 0,
                "max_iterations": 0,
                "new_links": 0,
                "raw_links": [],
                "successful_iterations": 0,
                "failed_iterations": 0,
            }
        return {
            "iteration": int(progress[0]),
            "max_iterations": int(progress[1]),
            "new_links": int(progress[2]),
            "raw_links": raw_links,
            "successful_iterations": int(progress[4]),
            "failed_iterations": int(progress[5]),
        }

    @staticmethod
    def find_latest_incomplete_run(artifacts_root: Path) -> Path | None:
        if not artifacts_root.exists():
            return None
        candidates = sorted(
            [path / "run.db" for path in artifacts_root.iterdir() if path.is_dir() and (path / "run.db").exists()],
            key=lambda path: path.parent.stat().st_mtime,
            reverse=True,
        )
        for db_path in candidates:
            store = RunStore(db_path)
            stage_status = store.fetch_stage_status()
            if stage_status.get("verify") == "success":
                continue
            return db_path
        return None

    def fetch_stage_status(self) -> dict[str, str]:
        result = {name: "pending" for name in DEFAULT_STAGES}
        with sqlite3.connect(self.path) as connection:
            rows = connection.execute(
                """
                SELECT stage_name, status
                FROM stage_events
                ORDER BY rowid ASC
                """
            ).fetchall()
        for stage_name, status in rows:
            result[stage_name] = status
        return result

    def fetch_source_progress(self) -> dict[str, dict[str, int]]:
        with sqlite3.connect(self.path) as connection:
            rows = connection.execute(
                """
                SELECT source_name, iteration, max_iterations, new_links, raw_links,
                       successful_iterations, failed_iterations
                FROM source_progress
                ORDER BY source_name ASC
                """
            ).fetchall()
        return {
            source_name: {
                "iteration": iteration,
                "max_iterations": max_iterations,
                "new_links": new_links,
                "raw_links": raw_links,
                "successful_iterations": successful_iterations,
                "failed_iterations": failed_iterations,
            }
            for (
                source_name,
                iteration,
                max_iterations,
                new_links,
                raw_links,
                successful_iterations,
                failed_iterations,
            ) in rows
        }

    def count_links(self, table_name: str) -> int:
        with sqlite3.connect(self.path) as connection:
            row = connection.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()
        return int(row[0] if row else 0)
