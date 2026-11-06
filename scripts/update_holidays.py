"""Build holidays.json (Thai public holidays) from Google's public Thai holiday calendar.

Run by .github/workflows/update-holidays.yml every month; can also be run locally:
    python scripts/update_holidays.py
Only events marked "วันหยุดนักขัตฤกษ์" (public holiday) are kept; observances such as
Valentine's Day are ignored. Long royal names are shortened for the small calendar cells.
"""
import datetime
import json
import pathlib
import re
import urllib.request

ICS_URL = "https://calendar.google.com/calendar/ical/th.th%23holiday%40group.v.calendar.google.com/public/basic.ics"
OUT = pathlib.Path(__file__).resolve().parent.parent / "holidays.json"


def short_name(name: str) -> str:
    name = name.replace("​", "").replace("ขื้น", "ขึ้น").strip()  # also fix a typo in the source calendar
    sub = ""
    for prefix in ("วันหยุดชดเชย", "ชดเชย"):
        if name.startswith(prefix):
            sub, name = "ชดเชย", name[len(prefix):].strip()
            break
    rules = [
        (("วชิราลงกรณ",), "วันเฉลิมฯ ร.10"),
        (("สุทิดา",), "วันเฉลิมฯ พระราชินี"),
        (("สิริกิติ์",), "วันแม่แห่งชาติ"),
        (("สวรรคต",), "วันนวมินทรมหาราช"),
        (("พระบรมราชสมภพ", "ภูมิพล"), "วันพ่อแห่งชาติ"),
        (("ปิยมหาราช",), "วันปิยมหาราช"),
        (("รัฐธรรมนูญ",), "วันรัฐธรรมนูญ"),
    ]
    for keys, short in rules:
        if all(k in name for k in keys):
            name = short
            break
    if len(name) > 22:
        name = name[:21] + "…"
    if sub:
        name = "ชดเชย" + (name[3:] if name.startswith("วัน") else name)
    return name


def main() -> None:
    raw = urllib.request.urlopen(ICS_URL, timeout=30).read().decode("utf-8")
    raw = raw.replace("\r\n ", "").replace("\r\n", "\n")
    this_year = datetime.date.today().year
    holidays = {}
    for event in re.findall(r"BEGIN:VEVENT(.*?)END:VEVENT", raw, re.S):
        start = re.search(r"DTSTART;VALUE=DATE:(\d{8})", event)
        summary = re.search(r"SUMMARY:(.*)", event)
        desc = re.search(r"DESCRIPTION:(.*)", event)
        if not (start and summary and desc and desc.group(1).startswith("วันหยุดนักขัตฤกษ์")):
            continue
        d = start.group(1)
        if int(d[:4]) < this_year - 1:
            continue
        holidays[f"{d[:4]}-{d[4:6]}-{d[6:]}"] = short_name(summary.group(1))
    if len(holidays) < 10:
        raise SystemExit(f"Too few holidays parsed ({len(holidays)}); refusing to overwrite.")
    data = dict(sorted(holidays.items()))
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {len(data)} holidays to {OUT.name}: {min(data)} .. {max(data)}")


if __name__ == "__main__":
    main()
