#!/usr/bin/env python3
import argparse
import json
import sqlite3
import sys
import time

DEFAULT_DB = "/home/jm/.omo/omonyang/durable/inbox.sqlite"
DEFAULT_INTERVAL_SECONDS = 300


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--interval-seconds", type=int, default=DEFAULT_INTERVAL_SECONDS)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def main():
    args = parse_args()
    now = int(time.time() * 1000)
    retry_at = now + args.interval_seconds * 1000
    database = f"file:{args.db}?mode=ro" if args.dry_run else args.db
    connection = sqlite3.connect(database, uri=args.dry_run)
    try:
        scheduled_rows = connection.execute(
            "SELECT id FROM work_items "
            "WHERE state IN ('waiting', 'working') AND retry_at IS NULL"
        ).fetchall()
        due_rows = connection.execute(
            "SELECT id FROM work_items "
            "WHERE state = 'waiting' AND retry_at IS NOT NULL AND retry_at <= ? "
            "ORDER BY retry_at, id",
            (now,),
        ).fetchall()
        finished_rows = connection.execute(
            "SELECT w.id FROM work_items w JOIN events e ON e.id = w.id "
            "WHERE w.state IN ('waiting', 'working', 'blocked', 'delegated') "
            "AND e.state = 'completed'"
        ).fetchall()
        if not args.dry_run and finished_rows:
            connection.execute(
                "UPDATE work_items SET state = 'done', retry_at = NULL, updated_at = ? "
                "WHERE id IN (SELECT w.id FROM work_items w JOIN events e ON e.id = w.id "
                "WHERE w.state IN ('waiting', 'working', 'blocked', 'delegated') "
                "AND e.state = 'completed')",
                (now,),
            )
        if not args.dry_run and scheduled_rows:
            connection.execute(
                "UPDATE work_items SET retry_at = ? "
                "WHERE state IN ('waiting', 'working') AND retry_at IS NULL",
                (retry_at,),
            )
        if not args.dry_run:
            connection.commit()
    finally:
        connection.close()

    due_ids = [row[0] for row in due_rows]
    result = {
        "scheduled": len(scheduled_rows),
        "due": len(due_ids),
        "closed": len(finished_rows),
        "dry_run": args.dry_run,
        "due_ids": due_ids,
    }
    if args.json:
        print(json.dumps(result))
    else:
        print(
            f"RETRY_SWEEP scheduled={result['scheduled']} due={result['due']} "
            f"closed={result['closed']} dry_run={str(result['dry_run']).lower()}"
        )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(error, file=sys.stderr)
        sys.exit(1)
