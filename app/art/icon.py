"""Draws the Even Hub store icon: a rabbit's head.

Even's rules: a 24 x 24 PNG in which every pixel is either fully transparent or opaque
#F4F4F4, and lit pixels come in 2 x 2 blocks. So the picture is a 12 x 12 grid, each
cell doubled. Run from the app folder:  python3 art/icon.py   (writes art/icon.png)
"""
import struct, zlib

GRID = [
    '...#....#...',
    '..##....##..',
    '..##....##..',
    '..##....##..',
    '..########..',
    '.##########.',
    '.##.####.##.',
    '.##########.',
    '.####..####.',
    '.##########.',
    '..########..',
    '............',
]
assert len(GRID) == 12 and all(len(row) == 12 for row in GRID)

LIT, CLEAR = bytes([0xF4, 0xF4, 0xF4, 0xFF]), bytes(4)
rows = b''
for row in GRID:
    line = b'\x00' + b''.join((LIT if cell == '#' else CLEAR) * 2 for cell in row)
    rows += line * 2


def chunk(kind, data):
    body = kind + data
    return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body))


png = (
    b'\x89PNG\r\n\x1a\n'
    + chunk(b'IHDR', struct.pack('>IIBBBBB', 24, 24, 8, 6, 0, 0, 0))
    + chunk(b'IDAT', zlib.compress(rows, 9))
    + chunk(b'IEND', b'')
)
open('art/icon.png', 'wb').write(png)
print(f'wrote art/icon.png: 24 x 24, {len(png)} bytes')
