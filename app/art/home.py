"""Draws the home-screen picture: a rabbit beside its burrow, under a tree.

The glasses show 16 levels of green on black, so the art uses brightness levels 0 to 15.
It is drawn on a 96 x 48 grid and scaled 3x to 288 x 144, the largest picture the display
allows. Run from the app folder:  python3 art/home.py
It writes src/home-0.png to home-7.png (the frames of the opening screen's animation: the
moon bobs and the stars twinkle) and art/logo.png (the first frame in green, for the README).
"""
import struct, sys, zlib

W, H, SCALE = 96, 48, 3
GROUND = 39
px = [[0] * W for _ in range(H)]


def dot(x, y, level):
    if 0 <= x < W and 0 <= y < H:
        px[y][x] = level


def ellipse(cx, cy, rx, ry, level, only=lambda x, y: True):
    for y in range(int(cy - ry) - 1, int(cy + ry) + 2):
        for x in range(int(cx - rx) - 1, int(cx + rx) + 2):
            if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1 and only(x, y):
                dot(x, y, level)


def rect(x0, y0, x1, y1, level):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            dot(x, y, level)


# The display is far from linear: level 4 of 15 already shows at about two thirds of
# full brightness and level 1 at a little under half, so gentle shading disappears.
# The picture is therefore built from three levels and from black gaps.
BRIGHT, MID, DIM = 15, 4, 1

# ── sky: a crescent moon and a few stars, which move (see `frame` below) ──
# The app shows the frames in turn. The moon steps one art pixel (three on the display) up,
# back, down, back, holding each place for two frames; each star runs through TWINKLE,
# every star starting at a different point so that they do not blink together. The light
# the moon throws on the tree moves with it.
STARS = [(26, 5), (38, 10), (52, 4), (64, 9), (4, 20), (31, 16), (92, 6)]
MOON = [0, 0, -1, -1, 0, 0, 1, 1]
TWINKLE = [MID, MID, BRIGHT, MID, MID, DIM, 0, DIM]


def frame(step):
    """The finished scene with the sky as it is at `step`. The scene stays in front."""
    global px
    scene, px = px, [[0] * W for _ in range(H)]
    ellipse(11, 8 + MOON[step], 4.5, 4.5, BRIGHT)
    ellipse(13, 7 + MOON[step], 4, 4, 0)
    for i, (x, y) in enumerate(STARS):
        dot(x, y, TWINKLE[(step + 3 * i) % len(TWINKLE)])
    px = [[s or k for s, k in zip(scene_row, sky_row)] for scene_row, sky_row in zip(scene, px)]
    for cx, cy, r in LIT:  # moonlight on the tree, following the moon up and down
        ellipse(cx, cy + MOON[step], r, r * 0.7, BRIGHT, only=lambda x, y: (x, y) in CANOPY)
    for x, y in GAPS:
        dot(x, y, 0)  # gaps between the leaves
    for i, (x, y) in enumerate(GLINTS):
        if step in (2 * i + 1, 2 * i + 2):
            dot(x, y, BRIGHT)
    out, px = px, scene
    return out


# ── tree: trunk, a branch, and a canopy of clumps separated by dark gaps ──
rect(78, 22, 81, GROUND, MID)
rect(79, 22, 79, GROUND, BRIGHT)  # lit side of the trunk
for i in range(5):  # branch reaching left
    dot(77 - i, 27 - i, MID)
    dot(77 - i, 28 - i, MID)
clumps = [(80, 12, 9), (71, 17, 6.5), (89, 17, 6.5), (76, 21, 5), (85, 21, 5)]
for cx, cy, r in clumps:
    ellipse(cx, cy, r, r * 0.85, MID)
CANOPY = {(x, y) for y in range(H) for x in range(W)
          if any(((x - cx) / r) ** 2 + ((y - cy) / (r * 0.85)) ** 2 <= 1 for cx, cy, r in clumps)}
# The moonlight on the canopy is drawn per frame (see `frame`): the moon is to the upper
# left, so each clump is lit on its upper left, and the lit patches rise and sink with it.
LIT = [(78, 10, 6), (70, 15, 3.5), (88, 15, 3.5)]
GAPS = [(77, 17), (78, 18), (83, 16), (84, 17), (71, 21), (90, 20), (81, 22), (74, 13), (75, 14), (86, 13), (85, 14), (80, 19)]
# Single leaves that catch the light for two frames each, one after another, so a glint
# wanders across the shaded part of the canopy. None is lit in frame 0 (the logo).
GLINTS = [(67, 19), (75, 23), (84, 19)]

# ── burrow: a dim mound with a bright rim around a black hole ──
ellipse(27, GROUND, 17, 9, MID, only=lambda x, y: y <= GROUND)
ellipse(27, GROUND, 15.8, 8, DIM, only=lambda x, y: y <= GROUND)
for x, y in [(15, 37), (19, 34), (36, 34), (40, 37), (22, 33), (33, 33)]:
    dot(x, y, MID)  # pebbles on the mound
ellipse(28, 36, 7.5, 4.6, BRIGHT, only=lambda x, y: y <= GROUND)  # rim of the hole
ellipse(28, 36.6, 6.3, 3.9, 0, only=lambda x, y: y <= GROUND)  # the hole itself

# ── ground line and grass ──
rect(0, GROUND, W - 1, GROUND, MID)
for x in [3, 9, 46, 66, 72, 86, 93]:
    dot(x, GROUND - 1, BRIGHT)
    dot(x + 1, GROUND - 2, BRIGHT)
    dot(x + 2, GROUND - 1, BRIGHT)
for x, y in [(6, 42), (20, 44), (35, 42), (50, 45), (61, 42), (75, 44), (88, 42), (13, 46), (43, 46), (69, 46), (94, 45)]:
    dot(x, y, DIM)  # soil

# ── rabbit: sitting, facing the burrow ──
ellipse(63.5, 34, 2.4, 2.4, MID)  # tail
ellipse(56, 32, 7.5, 6.5, BRIGHT)  # body
ellipse(58, 37, 4.5, 1.9, BRIGHT)  # hind foot
rect(49, 36, 52, 38, BRIGHT)  # front paws
ellipse(50, 32, 3, 4.5, BRIGHT)  # chest
ellipse(48.5, 24.5, 4.6, 4.2, BRIGHT)  # head
ellipse(46.5, 15.5, 1.5, 5.5, BRIGHT)  # near ear
ellipse(50.5, 14.5, 1.5, 6, BRIGHT)  # far ear
for y in range(11, 21):
    dot(48, y, 0)  # the gap that keeps the two ears apart
rect(46, 23, 47, 24, 0)  # eye
dot(44, 26, 0)  # nose
for x, y in [(54, 31), (55, 30), (56, 29), (57, 29), (58, 29), (59, 30)]:
    dot(x, y, 0)  # the top of the haunch

def chunk(kind, data):
    body = kind + data
    return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body))


def write_png(path, width, height, colour_type, rows):
    png = (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, colour_type, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(rows, 9))
        + chunk(b'IEND', b'')
    )
    open(path, 'wb').write(png)
    print(f'wrote {path}: {width} x {height}, {len(png)} bytes')


# ── the pictures the app sends to the glasses: 8-bit greyscale, level 15 = white ──
for step in range(len(MOON)):
    grey = b''.join(b'\x00' + bytes(v * 17 for v in row for _ in range(SCALE)) for row in frame(step) for _ in range(SCALE))
    write_png(f'src/home-{step}.png', W * SCALE, H * SCALE, 0, grey)
px = frame(0)

# ── the logo for the README: as the display shows it, in green and three times larger ──
LOGO = SCALE * 3
shown = [0] + [round(255 * (level / 15) ** 0.3) for level in range(1, 16)]  # the display's curve
green = b''.join(
    b'\x00' + b''.join(bytes([0, shown[v], 0]) * LOGO for v in row) for row in px for _ in range(LOGO)
)
write_png('art/logo.png', W * LOGO, H * LOGO, 2, green)
