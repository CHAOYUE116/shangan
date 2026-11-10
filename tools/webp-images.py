import sqlite3, io, os, sys, time
from PIL import Image

DB = r"D:\Projects\上岸APP\kaogong-shuati\app-assets\images.db"
APPLY = "--apply" in sys.argv
LIMIT = None
for i, a in enumerate(sys.argv):
    if a == "--limit":
        LIMIT = int(sys.argv[i + 1])

con = sqlite3.connect(DB)
cur = con.cursor()
before = os.path.getsize(DB)
total = cur.execute("SELECT COUNT(*) FROM images").fetchone()[0]
rows = cur.execute("SELECT key, mime, blob FROM images").fetchall()
print(f"库 {before/1048576:.1f} MB / {total} 张")

conv = []
new_bytes = 0
fail = 0
t0 = time.time()
for n, (key, mime, blob) in enumerate(rows):
    if LIMIT and n >= LIMIT:
        break
    if mime == "image/webp":
        new_bytes += len(blob)
        continue
    try:
        im = Image.open(io.BytesIO(blob))
        if im.mode not in ("RGBA", "RGB"):
            im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
        buf = io.BytesIO()
        im.save(buf, "WEBP", lossless=True, method=6)
        data = buf.getvalue()
        if len(data) < len(blob):
            new_bytes += len(data)
            conv.append((data, key))
        else:
            new_bytes += len(blob)
    except Exception as e:
        fail += 1
        new_bytes += len(blob)
print(f"可压缩 {len(conv)} 张 / 失败 {fail} / 预计新总字节 {new_bytes/1048576:.1f} MB / 耗时 {time.time()-t0:.0f}s")

if APPLY and conv:
    cur.executemany("UPDATE images SET blob = ?, mime = 'image/webp' WHERE key = ?", conv)
    con.commit()
    cur.execute("VACUUM")
    con.commit()
    after = os.path.getsize(DB)
    print(f"已写回 {len(conv)} 张，库 {before/1048576:.1f} -> {after/1048576:.1f} MB")
con.close()
