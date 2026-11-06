"""Bump the app version before every deploy.

    python scripts/bump_version.py            # 2026-11-06.13 -> today's date, next number
    python scripts/bump_version.py 2026-12-01.1

Updates APP_VERSION and the ?v= cache-busting query on styles.css / app.js in index.html,
so installed apps show the "new version" banner and download the new files.
"""
import datetime
import pathlib
import re
import sys

INDEX = pathlib.Path(__file__).resolve().parent.parent / "index.html"


def main() -> None:
    html = INDEX.read_text(encoding="utf-8")
    current = re.search(r"const APP_VERSION = '([^']+)'", html).group(1)
    if len(sys.argv) > 1:
        new = sys.argv[1]
    else:
        today = datetime.date.today().isoformat()
        day, _, num = current.partition(".")
        new = f"{today}.{int(num) + 1 if day == today and num.isdigit() else 1}"
    count = html.count(current)
    html = html.replace(current, new)
    INDEX.write_text(html, encoding="utf-8")
    print(f"{current} -> {new} ({count} places)")


if __name__ == "__main__":
    main()
