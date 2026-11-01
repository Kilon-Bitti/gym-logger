"""Draw the app icons (a barbell) with the Python standard library only."""
import pathlib, struct, zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
BG, FG, ACCENT = (17, 20, 24), (230, 237, 243), (47, 129, 247)


def draw(size):
    s = size / 180
    # (x0, y0, x1, y1, colour) in a 180 x 180 design grid
    rects = [
        (20, 86, 160, 94, FG),          # bar
        (34, 56, 48, 124, ACCENT),      # left plates
        (50, 66, 60, 114, ACCENT),
        (132, 56, 146, 124, ACCENT),    # right plates
        (120, 66, 130, 114, ACCENT),
        (14, 82, 22, 98, FG),           # bar ends
        (158, 82, 166, 98, FG),
    ]
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            c = BG
            for x0, y0, x1, y1, col in rects:
                if x0 * s <= x < x1 * s and y0 * s <= y < y1 * s:
                    c = col
            row += bytes(c)
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", raw) + chunk(b"IEND", b""))


for n in (180, 512):
    (ROOT / f"icon-{n}.png").write_bytes(draw(n))
