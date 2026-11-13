"""把 tmp-tarzan 里的成题图片压小后写进 images.db。

用法：
  python tools/pack-images.py --src tmp-tarzan --db app-assets/images.db

命名约定：文件名前 24 位是 sha1(url) 的前 24 位，作为 images.key；
题干里的 src 会被改写成 https://fb.fenbike.cn/api/planet/accessories/formulas?latex=<key>，
App 现有的 hydrateImages() 只认 `latex=` 后面的 key，不关心具体域名，所以能直接显示。
"""

import argparse
import io
import os
import sqlite3

from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("--src", default="tmp-tarzan")
ap.add_argument("--db", default="app-assets/images.db")
ap.add_argument("--width", type=int, default=560)
ap.add_argument("--quality", type=int, default=58)
ap.add_argument("--limit", type=int, default=0)
args = ap.parse_args()

files = sorted(os.listdir(args.src))
files = [f for f in files if not f.endswith(".json")]
if args.limit:
    files = files[: args.limit]

db = sqlite3.connect(args.db)
db.execute("CREATE TABLE IF NOT EXISTS images (key TEXT PRIMARY KEY, mime TEXT, blob BLOB)")
have = {r[0] for r in db.execute("SELECT key FROM images")}

ok = skip = fail = 0
raw = out = 0
rows = []
for i, name in enumerate(files):
    key = os.path.splitext(name)[0]
    if key in have:
        skip += 1
        continue
    p = os.path.join(args.src, name)
    try:
        raw += os.path.getsize(p)
        im = Image.open(p)
        im = im.convert("RGB") if im.mode not in ("RGB", "L") else im.convert("RGB")
        w, h = im.size
        if w > args.width:
            im = im.resize((args.width, max(1, round(h * args.width / w))), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=args.quality, optimize=True, progressive=True)
        blob = buf.getvalue()
        out += len(blob)
        rows.append((key, "image/jpeg", blob))
        ok += 1
    except Exception as e:  # noqa: BLE001
        fail += 1
        if fail <= 10:
            print("FAIL", name, e)
    if (i + 1) % 1000 == 0:
        print(f"  {i + 1}/{len(files)} ok={ok} skip={skip} fail={fail} 压缩后 {out / 1048576:.1f}MB")

db.executemany("INSERT OR REPLACE INTO images (key, mime, blob) VALUES (?,?,?)", rows)
db.commit()
db.execute("VACUUM")
db.commit()
size = os.path.getsize(args.db)
print(f"完成：写入 {ok} / 跳过 {skip} / 失败 {fail}；原始 {raw / 1048576:.1f}MB → 压缩 {out / 1048576:.1f}MB；images.db {size / 1048576:.1f}MB")
