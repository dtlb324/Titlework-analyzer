#!/usr/bin/env python3.11
"""Generate ~150 pages of realistic FAKE Texas (Permian Basin) title work.

Output: scanned-looking county-record PDFs (one instrument per file), an
answer_key.json, and a README.md, for judging OCR / abstraction models.

Everything here is fictional: people, companies, volumes, pages, instrument
numbers. County and survey names are real geography only.

REQUIREMENTS (macOS, python3.11)
  python3.11 -m venv /Users/loganbrown/.hermes/cache/scratch/titlework-gen-venv
  /Users/loganbrown/.hermes/cache/scratch/titlework-gen-venv/bin/pip install pillow numpy
  macOS system fonts under /System/Library/Fonts/Supplemental (Snell Roundhand,
  Apple Chancery, Bradley Hand, Brush Script, Savoye LET, Zapfino, Courier New,
  American Typewriter, Times New Roman, Arial, Georgia). No other packages.
  Optional: `pdftoppm` (poppler) for the byte-budget check (--check-lab).

RUN
  titlework-gen-venv/bin/python scripts/generate_realistic_titlework.py \
      --seed 1917 --out /Users/loganbrown/Downloads/realistic-titlework

Deterministic: same --seed, same bytes of content and key; the seed drives the
scan artifacts, handwriting wobble, stamp placement and recording numbers.

LAB CONSTRAINTS (public/ocr-compare.js): <=60 pages and <=12,000,000 bytes of
rendered page images per file. The browser renders each PDF page at scale 2
(PDF points x2) to a canvas, encodes PNG first, and only falls back to JPEG
(0.92..0.45) when the PNG total is over the cap. Pages are written at 150 dpi
(612x792 pt letter) so a scale-2 render is ~1224x1584 px, close to native.
The --check-lab step measures PNG bytes per file via pdftoppm -r 144.
"""
import argparse, datetime as dt, hashlib, io, json, math, os, random, re, subprocess, sys
from dataclasses import dataclass, field
import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps

DPI = 150
PW = 1275
PH = {"letter": 1650, "legal": 2100}
FD = "/System/Library/Fonts/Supplemental/"
FONT_FILES = {
    "snell": ("SnellRoundhand.ttc", 0), "snellb": ("SnellRoundhand.ttc", 1),
    "chancery": ("Apple Chancery.ttf", 0), "bradley": ("Bradley Hand Bold.ttf", 0),
    "savoye": ("Savoye LET.ttc", 0), "brush": ("Brush Script.ttf", 0), "zapf": ("Zapfino.ttf", 0),
    "courier": ("Courier New.ttf", 0), "courierb": ("Courier New Bold.ttf", 0),
    "courieri": ("Courier New Italic.ttf", 0), "courierbi": ("Courier New Bold Italic.ttf", 0),
    "amtype": ("AmericanTypewriter.ttc", 0), "amtypeb": ("AmericanTypewriter.ttc", 2),
    "amtypei": ("AmericanTypewriter.ttc", 0), "amtypebi": ("AmericanTypewriter.ttc", 2),
    "times": ("Times New Roman.ttf", 0), "timesb": ("Times New Roman Bold.ttf", 0),
    "timesi": ("Times New Roman Italic.ttf", 0), "timesbi": ("Times New Roman Bold Italic.ttf", 0),
    "arial": ("Arial.ttf", 0), "arialb": ("Arial Bold.ttf", 0), "arialn": ("Arial Narrow.ttf", 0),
    "arialnb": ("Arial Narrow Bold.ttf", 0), "georgia": ("Georgia.ttf", 0), "georgiab": ("Georgia Bold.ttf", 0),
    "georgiai": ("Georgia Italic.ttf", 0), "georgiabi": ("Georgia Bold Italic.ttf", 0),
    "impact": ("Impact.ttf", 0),
}
_FC = {}


def font(key, size):
    k = (key, int(size))
    if k not in _FC:
        f, i = FONT_FILES[key]
        _FC[k] = ImageFont.truetype(FD + f, int(size), index=i)
    return _FC[k]


def tw(key, size, text):
    return font(key, size).getlength(text)


# ----------------------------------------------------------------------------
# Inline markup:  <b> <i> <u>  <fill>typed value</fill>  <xout>text</xout>
#                 <ins>handwritten interlineation</ins>  <h:smudge>true text</h>
# ----------------------------------------------------------------------------
TAG = re.compile(r"<(/?)(b|i|u|fill|xout|ins|h)(?::(\w+))?>")


@dataclass
class Piece:
    text: str
    b: bool = False
    i: bool = False
    u: bool = False
    fill: bool = False
    xout: bool = False
    ins: bool = False
    hard: str = ""


def _protect(s):
    def fix(m):
        if m.group(1) == "<fill>" and len(m.group(2)) > 38:
            return m.group(0)
        return m.group(1) + re.sub(r"\s", "\ue000", m.group(2)) + m.group(3)
    return re.sub(r"(<(?:ins|fill|h(?::\w+)?)>)(.*?)(</(?:ins|fill|h)>)", fix, s, flags=re.S)


def parse_markup(s):
    s = _protect(s)
    st = {"b": 0, "i": 0, "u": 0, "fill": 0, "xout": 0, "ins": 0}
    hard = []
    out = []
    pos = 0
    for m in TAG.finditer(s):
        if m.start() > pos:
            out.append((s[pos:m.start()], dict(st), hard[-1] if hard else ""))
        close, name, arg = m.group(1) == "/", m.group(2), m.group(3)
        if name == "h":
            if close:
                hard.pop()
            else:
                hard.append(arg or "smudge")
        else:
            st[name] += -1 if close else 1
        pos = m.end()
    if pos < len(s):
        out.append((s[pos:], dict(st), hard[-1] if hard else ""))
    words, cur = [], []
    for text, f, h in out:
        for part in re.split(r"(\s+)", text):
            if not part:
                continue
            if part.isspace():
                if cur:
                    words.append(cur)
                    cur = []
                if "\n" in part:
                    words.append("NL")
                continue
            cur.append(Piece(part.replace("\ue000", " "), bool(f["b"]), bool(f["i"]), bool(f["u"]), bool(f["fill"]),
                             bool(f["xout"]), bool(f["ins"]), h))
    if cur:
        words.append(cur)
    return words


def strip_markup(s):
    return re.sub(r"\s+", " ", TAG.sub("", s)).strip()


# ----------------------------------------------------------------------------
# Page canvas: one 'L' mask per ink class; composited later by scan simulation
# ----------------------------------------------------------------------------
class Page:
    def __init__(self, w, h, side="R"):
        self.w, self.h, self.side = w, h, side
        self.masks = {}
        self.hard = []          # dicts: kind, bbox, text
        self.notes = []
        self.meta = {}

    def m(self, name):
        if name not in self.masks:
            self.masks[name] = Image.new("L", (self.w, self.h), 0)
        return self.masks[name]

    def d(self, name):
        return ImageDraw.Draw(self.m(name))

    def paste(self, name, img, xy, op="lighter"):
        base = self.m(name)
        x, y = int(xy[0]), int(xy[1])
        box = (x, y, x + img.width, y + img.height)
        cx0, cy0 = max(0, x), max(0, y)
        cx1, cy1 = min(self.w, box[2]), min(self.h, box[3])
        if cx1 <= cx0 or cy1 <= cy0:
            return
        src = img.crop((cx0 - x, cy0 - y, cx1 - x, cy1 - y))
        reg = base.crop((cx0, cy0, cx1, cy1))
        base.paste(ImageChops.lighter(reg, src), (cx0, cy0))


@dataclass
class Cfg:
    """Text layout + typographic style for one instrument."""
    family: str = "times"        # roman key; b/i variants resolved as family+'b' etc
    size: int = 25
    line_h: int = 31
    left: int = 160
    right: int = 160
    top: int = 170
    bottom: int = 170
    mode: str = "print"          # 'print' (crisp), 'typed' (typewriter jitter), 'hand' (script)
    mask: str = "print"
    fill_family: str = "courier"
    fill_size: int = 23
    fill_mask: str = "ink"
    align: str = "justify"
    para_gap: int = 0
    first_indent: int = 0
    base_off: float = 0.74       # baseline offset inside the line box
    hand_scale: float = 1.0
    jit: float = 1.0
    ruled: bool = False


class Flow:
    def __init__(self, rng, cfg, page_h, chrome=None, side_start="R"):
        self.rng, self.cfg, self.ph = rng, cfg, page_h
        self.pages = []
        self.chrome = chrome
        self.side0 = side_start
        self.y = 0
        self.new_page()

    # -- pages --------------------------------------------------------------
    def new_page(self):
        side = self.side0 if len(self.pages) % 2 == 0 else ("L" if self.side0 == "R" else "R")
        p = Page(PW, self.ph, side)
        self.pages.append(p)
        self.y = self.cfg.top
        if self.chrome:
            self.chrome(self, p, len(self.pages) - 1)
        return p

    @property
    def page(self):
        return self.pages[-1]

    def need(self, h):
        if self.y + h > self.ph - self.cfg.bottom:
            self.new_page()

    def space(self, px):
        self.y += px

    def lines_space(self, n=1):
        self.y += n * self.cfg.line_h

    # -- font resolution ----------------------------------------------------
    def fkey(self, pc, cfg=None):
        cfg = cfg or self.cfg
        fam = cfg.family
        if fam in ("snell", "chancery", "bradley", "savoye", "brush"):
            return fam if not pc.b else ("snellb" if fam == "snell" else fam)
        suffix = ("b" if pc.b else "") + ("i" if pc.i else "")
        key = fam + suffix
        return key if key in FONT_FILES else fam

    def piece_w(self, pc, cfg):
        if pc.ins:
            return 0
        if pc.fill:
            return tw(cfg.fill_family, cfg.fill_size, pc.text) + 2
        return tw(self.fkey(pc, cfg), cfg.size, pc.text) * (1.0)

    # -- paragraph ------------------------------------------------------------
    def para(self, markup, align=None, indent=0, first=None, gap=None, left=None, right=None,
             keep=0, cfg=None, nlines_min=0):
        cfg = cfg or self.cfg
        align = align or cfg.align
        first = cfg.first_indent if first is None else first
        gap = cfg.para_gap if gap is None else gap
        L = cfg.left + indent + (left or 0)
        R = PW - cfg.right - (right or 0)
        words = parse_markup(markup)
        sp = tw(self.fkey(Piece("x"), cfg), cfg.size, " ")
        if cfg.mode == "typed" and "courier" in cfg.family:
            sp = tw(cfg.family, cfg.size, "M")
        lines, cur, curw = [], [], 0.0
        avail = R - L - first
        hard_break_after = set()
        for w in words:
            if w == "NL":
                lines.append((cur, True))
                cur, curw = [], 0.0
                avail = R - L
                continue
            ww = sum(self.piece_w(p, cfg) for p in w)
            extra = sp if cur else 0
            if cur and curw + extra + ww > avail:
                lines.append((cur, False))
                cur, curw = [], 0.0
                avail = R - L
                extra = 0
            cur.append((w, ww))
            curw += extra + ww
        if cur:
            lines.append((cur, True))
        need = len(lines) * cfg.line_h
        if keep:
            self.need(min(need, keep * cfg.line_h))
        first_line = True
        for idx, (lw, last) in enumerate(lines):
            self.need(cfg.line_h)
            x0 = L + (first if idx == 0 else 0)
            width = R - x0
            total = sum(w for _, w in lw)
            nsp = len(lw) - 1
            if align == "justify" and not last and nsp > 0:
                s = (width - total) / nsp
                s = min(s, sp * 3.2)
            else:
                s = sp
            if align == "center":
                x0 = L + (R - L - (total + s * nsp)) / 2
            elif align == "right":
                x0 = R - (total + s * nsp)
            x = x0
            base = self.y + cfg.line_h * cfg.base_off
            for w, ww in lw:
                self.draw_word(w, x, base, cfg)
                x += ww + s
            self.y += cfg.line_h
        self.y += gap
        return self

    def tabline(self, items, cfg=None, dy=0):
        """items: [(x_offset_from_left, markup, 'l'|'c'|'r')] on a single line."""
        cfg = cfg or self.cfg
        self.need(cfg.line_h)
        base = self.y + cfg.line_h * cfg.base_off
        for xo, mk, al in items:
            words = parse_markup(mk)
            ww = [(w, sum(self.piece_w(p, cfg) for p in w)) for w in words if w != "NL"]
            sp = tw(cfg.family, cfg.size, "M") if (cfg.mode == "typed" and "courier" in cfg.family) else tw(self.fkey(Piece("x"), cfg), cfg.size, " ")
            total = sum(w for _, w in ww) + sp * max(0, len(ww) - 1)
            x = cfg.left + xo
            if al == "c":
                x -= total / 2
            elif al == "r":
                x -= total
            for w, wd in ww:
                self.draw_word(w, x, base, cfg)
                x += wd + sp
        self.y += cfg.line_h

    # -- drawing a word -----------------------------------------------------
    def draw_word(self, pieces, x, base, cfg):
        rng = self.rng
        pg = self.page
        for pc in pieces:
            w = self.piece_w(pc, cfg)
            if pc.ins:
                self.draw_interline(pc, x, base, cfg)
                continue
            if pc.fill:
                fk, fs = cfg.fill_family, cfg.fill_size
                if cfg.mode == "print":        # printed form: blank rule + typed text
                    pg.d(cfg.mask).line([(x - 2, base + 3), (x + w + 4, base + 3)], fill=200, width=2)
                    dx, dy = (rng.uniform(-2, 7), rng.uniform(-5, 2.5)) if cfg.fill_family == "courier" else (0, 0)
                    if cfg.fill_family == "courier":
                        self.type_text(pg, x + 2 + dx, base + dy, pc.text, fk, fs, cfg.fill_mask, bold=pc.b)
                    else:
                        pg.d(cfg.mask).text((x + 2, base), pc.text, font=font(fk, fs), fill=255, anchor="ls")
                    bbox = (x, base - fs, x + w, base + 6)
                else:
                    self.type_text(pg, x, base, pc.text, fk, fs, cfg.fill_mask, bold=pc.b)
                    bbox = (x, base - fs, x + w, base + 6)
            else:
                fk = self.fkey(pc, cfg)
                if cfg.mode == "typed":
                    self.type_text(pg, x, base, pc.text, fk, cfg.size, cfg.mask, bold=pc.b, jit=cfg.jit)
                    if pc.xout:
                        self.type_text(pg, x, base, "x" * len(pc.text), cfg.family, cfg.size, cfg.mask, jit=cfg.jit)
                elif cfg.mode == "hand":
                    self.hand_text(pg, x, base, pc.text, fk, cfg)
                    if pc.xout:
                        pg.d(cfg.mask).line([(x, base - cfg.size * .25), (x + w, base - cfg.size * .35)], fill=235, width=3)
                else:
                    pg.d(cfg.mask).text((x, base), pc.text, font=font(fk, cfg.size), fill=255, anchor="ls")
                    if pc.xout:
                        pg.d(cfg.mask).line([(x, base - cfg.size * .3), (x + w, base - cfg.size * .3)], fill=255, width=2)
                if pc.u:
                    pg.d(cfg.mask).line([(x, base + 4), (x + w, base + 4)], fill=230, width=2)
                bbox = (x, base - cfg.size * 0.85, x + w, base + cfg.size * 0.3)
            if pc.hard:
                pg.hard.append({"kind": pc.hard, "bbox": tuple(int(v) for v in bbox), "text": pc.text})
            x += w

    def type_text(self, pg, x, base, text, fk, size, mask, bold=False, jit=1.0):
        rng = self.rng
        f = font(fk, size)
        cw = f.getlength("M")
        d = pg.d(mask)
        for ch in text:
            if ch != " ":
                v = int(rng.uniform(165, 255))
                if ch in ".,'`-_:;":
                    v = int(v * 0.9)
                yy = base + rng.uniform(-1.4, 1.4) * jit
                xx = x + rng.uniform(-0.9, 0.9) * jit
                d.text((xx, yy), ch, font=f, fill=v, anchor="ls")
                if bold:
                    d.text((xx + 1.2, yy), ch, font=f, fill=v, anchor="ls")
            x += cw if "courier" in fk else f.getlength(ch)

    def hand_text(self, pg, x, base, text, fk, cfg, mask=None):
        rng = self.rng
        mask = mask or cfg.mask
        f = font(fk, int(cfg.size * cfg.hand_scale))
        w = int(f.getlength(text)) + 40
        asc, desc = f.getmetrics()
        h = asc + desc + 30
        tmp = Image.new("L", (w, h), 0)
        ImageDraw.Draw(tmp).text((20, asc + 10), text, font=f, fill=int(rng.uniform(205, 255)), anchor="ls")
        ang = rng.uniform(-1.1, 1.1) * cfg.jit
        tmp = tmp.rotate(ang, resample=Image.BICUBIC, expand=True)
        ox = x - 20 - (tmp.width - w) / 2
        oy = base - asc - 10 - (tmp.height - h) / 2 + rng.uniform(-1.8, 1.8) * cfg.jit
        pg.paste(mask, tmp, (ox, oy))

    def draw_interline(self, pc, x, base, cfg):
        """Handwritten interlineation above the line with a caret, then initials."""
        rng = self.rng
        pg = self.page
        txt = pc.text
        f = font("bradley", 30)
        yy = base - cfg.line_h * 0.44
        pg.d("hand").text((x - 5, base + 2), "^", font=font("courier", 22), fill=230, anchor="ls")
        self.hand_text(pg, x - 6, yy, txt, "bradley", Cfg(size=27, mask="hand", jit=1.3))
        ini = getattr(self, "initials", "")
        if ini:
            self.hand_text(pg, x - 6 + tw("bradley", 27, txt) + 8, yy - 4, ini, "bradley", Cfg(size=22, mask="hand", jit=1.3))

    # -- misc blocks ----------------------------------------------------------
    def rule(self, x0=None, x1=None, v=200, width=2, dy=0):
        x0 = self.cfg.left if x0 is None else x0
        x1 = PW - self.cfg.right if x1 is None else x1
        self.page.d(self.cfg.mask).line([(x0, self.y + dy), (x1, self.y + dy)], fill=v, width=width)

# ----------------------------------------------------------------------------
# Recording artifacts: stamps, seals, signatures, barcodes, plat sketches
# ----------------------------------------------------------------------------
SIG_FONTS = [("brush", 74), ("savoye", 84), ("zapf", 52), ("bradley", 58), ("chancery", 64), ("snell", 74)]


def _h(s):
    return int(hashlib.md5(s.encode()).hexdigest()[:8], 16)


def _nrng(rng):
    return np.random.default_rng(rng.getrandbits(63))


def nfield(rng, w, h, scale):
    g = _nrng(rng)
    sw, sh = max(2, w // scale + 2), max(2, h // scale + 2)
    a = g.random((sh, sw)).astype(np.float32)
    im = Image.fromarray((a * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC)
    return np.asarray(im, dtype=np.float32) / 255.0


def patchy(img, rng, strength=0.35, scale=18):
    """Multiply an 'L' stamp image by patchy ink coverage."""
    w, h = img.size
    f = nfield(rng, w, h, scale)
    a = np.asarray(img, dtype=np.float32) * (1 - strength * f)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def rubber_stamp(pg, rng, x, y, lines, mask, angle=0.0, size=30, font_key="arialnb", box=True,
                 double=False, partial=False, faint=False, pad=14, line_gap=1.18, w_min=0):
    f = font(font_key, size)
    ws = [f.getlength(t) for t in lines]
    W = int(max(ws + [w_min]) + pad * 2 + 12)
    H = int(len(lines) * size * line_gap + pad * 2)
    img = Image.new("L", (W + 40, H + 40), 0)
    d = ImageDraw.Draw(img)
    if box:
        d.rectangle([20, 20, 20 + W, 20 + H], outline=255, width=4)
        d.rectangle([20 + 6, 20 + 6, 20 + W - 6, 20 + H - 6], outline=255, width=1)
    for i, t in enumerate(lines):
        d.text((20 + W / 2, 20 + pad + size * line_gap * (i + .5)), t, font=f, fill=255, anchor="mm")
    img = patchy(img, rng, 0.45 if not faint else 0.6, 14)
    if partial:
        w2, h2 = img.size
        ramp = np.linspace(1.0, rng.uniform(0.0, .25), w2, dtype=np.float32)[None, :]
        if rng.random() < .5:
            ramp = ramp[:, ::-1]
        a = np.asarray(img, dtype=np.float32) * ramp
        img = Image.fromarray(a.astype(np.uint8))
    if faint:
        img = img.point(lambda v: int(v * 0.42))
    img = img.filter(ImageFilter.GaussianBlur(0.8))
    outs = [(img, angle, 0, 0)]
    if double:
        outs.append((img.point(lambda v: int(v * 0.55)), angle + rng.uniform(1.0, 2.0), rng.uniform(3, 6), rng.uniform(2, 5)))
    bbox = None
    for im, ang, dx, dy in outs:
        r = im.rotate(ang, resample=Image.BICUBIC, expand=True)
        pg.paste(mask, r, (x + dx - 20, y + dy - 20))
        bbox = (int(x), int(y), int(x + r.width), int(y + r.height))
    return bbox


def arc_text(img, cx, cy, r, text, fnt, a0, a1, bottom=False, fill=255):
    n = len(text)
    for i, ch in enumerate(text):
        t = a0 + (a1 - a0) * (i + .5) / n
        ang = math.radians(t)
        px, py = cx + r * math.cos(ang), cy + r * math.sin(ang)
        cimg = Image.new("L", (80, 80), 0)
        ImageDraw.Draw(cimg).text((40, 40), ch, font=fnt, fill=fill, anchor="mm")
        rot = (-(t + 90)) if not bottom else (-(t - 90))
        cimg = cimg.rotate(rot, resample=Image.BICUBIC)
        img.paste(ImageChops.lighter(img.crop((int(px - 40), int(py - 40), int(px + 40), int(py + 40))), cimg), (int(px - 40), int(py - 40)))


def star(d, cx, cy, r, fill=255):
    pts = []
    for k in range(10):
        rr = r if k % 2 == 0 else r * .42
        a = math.radians(-90 + k * 36)
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    d.polygon(pts, fill=fill)


def round_seal(pg, rng, cx, cy, r, top, bottom, mask="seal", strength=0.8, ring=3):
    S = int(r * 2 + 120)
    img = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(img)
    c = S // 2
    d.ellipse([c - r, c - r, c + r, c + r], outline=255, width=ring)
    d.ellipse([c - r + 9, c - r + 9, c + r - 9, c + r - 9], outline=255, width=1)
    d.ellipse([c - r * .52, c - r * .52, c + r * .52, c + r * .52], outline=255, width=2)
    fnt = font("arialnb", int(r * .2))
    arc_text(img, c, c, r * .76, top, fnt, 205, 335)
    arc_text(img, c, c, r * .76, bottom, fnt, 25, 155, bottom=True)
    star(d, c, c, r * .3)
    img = patchy(img, rng, 0.3, 10).filter(ImageFilter.GaussianBlur(1.0))
    img = img.point(lambda v: int(v * strength))
    img = img.rotate(rng.uniform(-12, 12), resample=Image.BICUBIC)
    pg.paste(mask, img, (cx - c, cy - c))


def barcode(pg, rng, x, y, w, h, text, mask="print"):
    """Code-39-style bars (cosmetic; encodes the digits' hash)."""
    d = pg.d(mask)
    bits = []
    seed = _h(text)
    r = random.Random(seed)
    cur = x
    d.rectangle([x, y, x + 3, y + h], fill=255)
    cur += 6
    while cur < x + w - 8:
        bw = r.choice([2, 2, 3, 5])
        if r.random() < .55:
            d.rectangle([cur, y, cur + bw, y + h], fill=255)
        cur += bw + 2
    d.text((x + w / 2, y + h + 4), text, font=font("arial", 18), fill=255, anchor="mt")


def signature(pg, rng, x, y, name, width=420, mask="hand", mark=False):
    """Scrawled signature centered on baseline y, starting at x."""
    if mark:
        pg.d(mask).text((x + 80, y - 8), "X", font=font("bradley", 70), fill=240, anchor="ls")
        pg.d(mask).text((x + 170, y - 4), "his mark", font=font("bradley", 26), fill=230, anchor="ls")
        return
    fk, fs = SIG_FONTS[_h(name) % len(SIG_FONTS)]
    parts = name.replace(",", "").split()
    short = " ".join([p if i in (0, len(parts) - 1) or len(p) > 3 else p for i, p in enumerate(parts)])
    f = font(fk, fs)
    wnat = f.getlength(short)
    if wnat > width:
        fs = int(fs * width / wnat)
        f = font(fk, max(30, fs))
    asc, desc = f.getmetrics()
    W = int(f.getlength(short)) + 160
    img = Image.new("L", (W, asc + desc + 120), 0)
    d = ImageDraw.Draw(img)
    d.text((40, asc + 50), short, font=f, fill=int(rng.uniform(220, 255)), anchor="ls")
    # scrawl underline flourish
    pts = []
    xx, yy = 40, asc + 60
    for k in range(7):
        pts.append((xx, yy + rng.uniform(-6, 6)))
        xx += (W - 120) / 6
    d.line(pts, fill=225, width=2)
    img = img.rotate(rng.uniform(-7, 5), resample=Image.BICUBIC, expand=True)
    pg.paste(mask, img, (x - 20, y - asc - 50 - (img.height - (asc + desc + 120)) / 2))


def notary_ink_stamp(pg, rng, x, y, name, expires, mask="stampB", angle=None):
    ang = rng.uniform(-4, 4) if angle is None else angle
    return rubber_stamp(pg, rng, x, y, ["NOTARY PUBLIC", "STATE OF TEXAS", name.upper(), "My Comm. Exp. " + expires],
                        mask, ang, size=22, font_key="arialn", pad=10, w_min=300)


def plat_sketch(pg, rng, x, y, w, h, spec):
    """Hand-ruled section sketch. spec: dict(title, section, route, labels)."""
    d = pg.d("ink")
    pm = pg.d("print")
    jit = lambda: rng.uniform(-1.6, 1.6)

    def jl(a, b, wd=3, dash=False, mask="ink", v=235):
        dd = pg.d(mask)
        n = 14
        pts = [(a[0] + (b[0] - a[0]) * t / n + jit(), a[1] + (b[1] - a[1]) * t / n + jit()) for t in range(n + 1)]
        if dash:
            for i in range(0, n, 2):
                dd.line([pts[i], pts[i + 1]], fill=v, width=wd)
        else:
            dd.line(pts, fill=v, width=wd)

    x0, y0, x1, y1 = x + 40, y + 70, x + w - 40, y + h - 60
    jl((x0, y0), (x1, y0)); jl((x1, y0), (x1, y1)); jl((x1, y1), (x0, y1)); jl((x0, y1), (x0, y0))
    jl(((x0 + x1) // 2, y0), ((x0 + x1) // 2, y1), 2, True)
    jl((x0, (y0 + y1) // 2), (x1, (y0 + y1) // 2), 2, True)
    f = font("arialn", 22)
    pg.d("print").text(((x0 + x1) / 2, y + 26), spec["title"], font=font("arialnb", 26), fill=255, anchor="mm")
    pg.d("print").text((x0 + 8, y0 - 14), "N", font=font("arialb", 24), fill=255, anchor="lb")
    for lab, (fx, fy) in spec.get("labels", []):
        pg.d("print").text((x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy), lab, font=f, fill=255, anchor="mm")
    # pipeline route
    r = spec.get("route")
    if r:
        pts = [(x0 + (x1 - x0) * a, y0 + (y1 - y0) * b) for a, b in r]
        for a, b in zip(pts, pts[1:]):
            jl(a, b, 5, False, "stampA", 235)
            jl((a[0], a[1] + 12), (b[0], b[1] + 12), 2, True, "ink")
            jl((a[0], a[1] - 12), (b[0], b[1] - 12), 2, True, "ink")
        pg.d("print").text((pts[0][0] + 20, pts[0][1] - 40), spec.get("route_label", "30' P/L ESMT"), font=f, fill=255, anchor="lm")
    # north arrow + scale
    ax, ay = x1 - 60, y1 - 80
    pm.line([(ax, ay + 50), (ax, ay)], fill=255, width=3)
    pm.polygon([(ax, ay - 14), (ax - 9, ay + 6), (ax + 9, ay + 6)], fill=255)
    pm.text((ax + 18, ay + 20), "N", font=font("arialb", 22), fill=255, anchor="lm")
    pm.text((x0, y1 + 28), spec.get("scale", "NOT TO SCALE"), font=f, fill=255, anchor="lm")
    return y + h

# ----------------------------------------------------------------------------
# Scan simulation
# ----------------------------------------------------------------------------
BASE_COLORS = {
    "ink": (28, 26, 30), "print": (22, 22, 24), "hand": (30, 40, 92), "pencil": (96, 96, 104),
    "stampA": (98, 42, 128), "stampB": (28, 70, 160), "stampC": (176, 36, 34), "seal": (118, 118, 124),
    "rule": (150, 172, 200), "redrule": (205, 120, 120), "blot": (52, 40, 30),
}
INKISH = ("ink", "print", "hand", "pencil")

PROFILES = {
    "book_old": dict(paper=(232, 216, 182), fade=(.82, .98), blotch=.30, grain=.14, blur=.7, paper_grain=.010, stain=.45,
                     edge=.9, fox=22, bleed=.12, vig=.55, grad=.10, gutter=.42, warp=7, skew=2.4, lid=34, speckle=0.66e-4,
                     dust=24, hair=1, streaks=0, punch=0, folds=0, gray=False, jpeg=(52, 64), contrast=None, ink="ink_old",
                     white_border=False),
    "book_cleaner": dict(paper=(238, 226, 196), fade=(.88, 1.0), blotch=.20, grain=.10, blur=.6, paper_grain=.009, stain=.3,
                         edge=.6, fox=8, bleed=.07, vig=.4, grad=.08, gutter=.30, warp=5, skew=1.6, lid=40, speckle=0.36e-4,
                         dust=12, hair=1, streaks=0, punch=0, folds=0, gray=False, jpeg=(58, 70), contrast=None, ink="ink_old"),
    "typed_aged": dict(paper=(236, 228, 206), fade=(.72, .95), blotch=.30, grain=.16, blur=.8, paper_grain=.011, stain=.28,
                       edge=.6, fox=10, bleed=.10, vig=.35, grad=.07, gutter=0, warp=0, skew=2.0, lid=44, speckle=0.60e-4,
                       dust=20, hair=1, streaks=0, punch=.35, folds=1, gray=False, jpeg=(55, 68), contrast=None),
    "carbon": dict(paper=(232, 228, 214), fade=(.74, .94), blotch=.34, grain=.18, blur=1.25, paper_grain=.012, stain=.5,
                   edge=.5, fox=6, bleed=.14, vig=.35, grad=.07, gutter=0, warp=0, skew=2.2, lid=46, speckle=0.75e-4,
                   dust=20, hair=1, streaks=0, punch=.4, folds=1, gray=False, jpeg=(52, 64), contrast=None, ink="carbon"),
    "copy": dict(paper=(246, 246, 244), fade=(.78, 1.0), blotch=.18, grain=.14, blur=.75, paper_grain=.020, stain=.15,
                 edge=.0, fox=0, bleed=.05, vig=.15, grad=.10, gutter=0, warp=0, skew=2.8, lid=14, speckle=2.10e-4,
                 dust=56, hair=1, streaks=3, punch=.3, folds=0, gray=True, jpeg=(50, 64), contrast=(30, 232, 1.0), bands=True),
    "copy_book": dict(paper=(246, 246, 244), fade=(.80, 1.0), blotch=.15, grain=.12, blur=.8, paper_grain=.018, stain=.1,
                      edge=.0, fox=0, bleed=.05, vig=.2, grad=.08, gutter=.5, warp=8, skew=2.0, lid=12, speckle=1.80e-4,
                      dust=44, hair=1, streaks=2, punch=0, folds=0, gray=True, jpeg=(50, 62), contrast=(24, 226, 1.0), bands=True),
    "micro_pos": dict(paper=(214, 214, 214), fade=(.88, 1.0), blotch=.20, grain=.16, blur=1.0, paper_grain=.030, stain=.2,
                      edge=.0, fox=0, bleed=.04, vig=.55, grad=.12, gutter=0, warp=0, skew=1.2, lid=24, speckle=1.50e-4,
                      dust=60, hair=2, streaks=4, punch=0, folds=0, gray=True, jpeg=(48, 60), contrast=(35, 225, 1.0), micro="pos"),
    "micro_neg": dict(paper=(214, 214, 214), fade=(.88, 1.0), blotch=.20, grain=.16, blur=1.0, paper_grain=.030, stain=.2,
                      edge=.0, fox=0, bleed=.04, vig=.55, grad=.12, gutter=0, warp=0, skew=1.2, lid=24, speckle=1.50e-4,
                      dust=60, hair=2, streaks=4, punch=0, folds=0, gray=True, jpeg=(48, 60), contrast=(35, 225, 1.0), micro="neg"),
    "modern": dict(paper=(250, 250, 249), fade=(.92, 1.0), blotch=.04, grain=.05, blur=.62, paper_grain=.008, stain=0,
                   edge=0, fox=0, bleed=.03, vig=.10, grad=.05, gutter=0, warp=0, skew=.9, lid=252, speckle=0.30e-4,
                   dust=8, hair=0, streaks=1, punch=0, folds=0, gray=True, jpeg=(66, 78), contrast=(0, 252, 1.0)),
    "modern_gray": dict(paper=(236, 236, 234), fade=(.80, .98), blotch=.12, grain=.10, blur=.8, paper_grain=.014, stain=.1,
                        edge=0, fox=0, bleed=.07, vig=.25, grad=.10, gutter=0, warp=0, skew=1.8, lid=24, speckle=0.90e-4,
                        dust=24, hair=1, streaks=2, punch=.15, folds=0, gray=True, jpeg=(56, 70), contrast=(18, 236, 1.0), bands=True),
}
INK_VARIANTS = {
    "ink_old": {"ink": (52, 38, 28), "hand": (50, 36, 28), "pencil": (96, 90, 84)},
    "carbon": {"ink": (70, 58, 118), "hand": (40, 48, 110), "print": (50, 44, 80)},
}


def apply_hard(pg, rng):
    for hs in pg.hard:
        x0, y0, x1, y1 = hs["bbox"]
        x0, y0, x1, y1 = max(0, x0 - 5), max(0, y0 - 5), min(pg.w, x1 + 5), min(pg.h, y1 + 5)
        kind = hs["kind"]
        if kind == "blot":
            bx, by = x0 + (x1 - x0) * rng.uniform(.62, .72), (y0 + y1) / 2 + rng.uniform(-3, 3)
            pts = []
            for k in range(14):
                a = k * 2 * math.pi / 14
                rr = rng.uniform(.75, 1.2) * ((y1 - y0) * .40)
                pts.append((bx + rr * math.cos(a) * 1.1, by + rr * math.sin(a)))
            tmp = Image.new("L", (pg.w, pg.h), 0)
            ImageDraw.Draw(tmp).polygon(pts, fill=235)
            tmp = tmp.crop((x0 - 20, y0 - 20, x1 + 20, y1 + 20)).filter(ImageFilter.GaussianBlur(1.6))
            pg.paste("blot", tmp, (x0 - 20, y0 - 20))
            continue
        for name in list(pg.masks):
            if name not in INKISH:
                continue
            m = pg.masks[name]
            reg = m.crop((x0, y0, x1, y1))
            if not reg.getbbox():
                continue
            if kind == "smudge":
                a = reg.filter(ImageFilter.GaussianBlur(1.5)).point(lambda v: int(min(255, v * 1.0)))
                b = ImageChops.offset(reg, 5, 3).filter(ImageFilter.GaussianBlur(1.3)).point(lambda v: int(v * .6))
                new = ImageChops.lighter(a, b)
            elif kind == "faint":
                new = reg.filter(ImageFilter.GaussianBlur(0.5)).point(lambda v: int(v * .62))
            else:
                new = reg
            m.paste(new, (x0, y0))


def _levels(a, lo, hi, gamma=1.0):
    a = (a - lo) / max(1.0, hi - lo)
    a = np.clip(a, 0, 1) ** gamma
    return a * 255


def compose(pg, prof, rng, reverse=None):
    W, H = pg.w, pg.h
    g = _nrng(rng)
    apply_hard(pg, rng)
    cols = dict(BASE_COLORS)
    cols.update(INK_VARIANTS.get(prof.get("ink"), {}))
    fade = rng.uniform(*prof["fade"])
    nb = nfield(rng, W, H, 64)
    ng = g.random((H, W), dtype=np.float32)
    ngm = nfield(rng, W, H, 4)
    T = np.ones((H, W, 3), np.float32)
    for name, m in pg.masks.items():
        br = prof["blur"] if name in INKISH else 0.8 if name.startswith("stamp") else 0.5
        if name == "seal":
            br = 1.0
        mm = m.filter(ImageFilter.GaussianBlur(br)) if br else m
        a = np.asarray(mm, np.float32) / 255.0
        if name in INKISH:
            a = a * fade
            a *= 1 - prof["blotch"] * np.clip((nb - 0.35) * 2.2, 0, 1)
            a *= 1 - prof["grain"] * np.clip(ng * 0.6 + ngm * 0.9 - 0.25, 0, 1.2)
            if name == "print":
                a *= 1.0
        elif name.startswith("stamp"):
            a *= rng.uniform(.82, 1.0) * (0.5 + 0.5 * (1 - prof["blotch"] * nb))
        elif name == "seal":
            a *= 0.7
        col = np.array(cols[name], np.float32) / 255.0
        T *= 1 - a[..., None] * (1 - col)[None, None, :]
    # paper
    paper = np.array(prof["paper"], np.float32) / 255.0
    P = np.ones((H, W, 3), np.float32) * paper
    tex = (g.standard_normal((H, W)).astype(np.float32) * prof["paper_grain"]) + (nfield(rng, W, H, 5) - .5) * prof["paper_grain"] * 2
    P *= (1 + tex)[..., None]
    if prof["stain"]:
        s = np.clip((nfield(rng, W, H, 260) - 0.52) * 2.6, 0, 1) * prof["stain"]
        P *= 1 - s[..., None] * np.array([.08, .16, .30], np.float32)
    if prof["edge"]:
        yy = np.minimum(np.arange(H), np.arange(H)[::-1])[:, None] / H
        xx = np.minimum(np.arange(W), np.arange(W)[::-1])[None, :] / W
        d = np.minimum(yy * H / W * 1.0, xx) / 0.06
        e = np.clip(1 - d, 0, 1) ** 2 * prof["edge"]
        P *= 1 - e[..., None] * np.array([.10, .20, .38], np.float32)
    img = P * T
    # foxing / spots
    if prof["fox"]:
        fx = Image.new("L", (W, H), 0)
        fd = ImageDraw.Draw(fx)
        for _ in range(int(prof["fox"] * rng.uniform(.5, 1.5))):
            r = rng.uniform(2, 9)
            x, y = rng.uniform(0, W), rng.uniform(0, H)
            fd.ellipse([x - r, y - r, x + r, y + r], fill=int(rng.uniform(25, 70)))
        fa = np.asarray(fx.filter(ImageFilter.GaussianBlur(2.5)), np.float32) / 255
        img *= 1 - fa[..., None] * np.array([.35, .6, .9], np.float32)
    # bleed-through from the reverse side
    if prof["bleed"]:
        if reverse is None:
            reverse = ImageChops.lighter(pg.masks.get("ink", Image.new("L", (W, H))), pg.masks.get("print", Image.new("L", (W, H))))
            reverse = ImageChops.offset(reverse, 0, rng.randint(-200, 200))
        bt = np.asarray(ImageOps.mirror(reverse).filter(ImageFilter.GaussianBlur(3.0)), np.float32) / 255.0
        img *= 1 - (bt * prof["bleed"])[..., None]
    # illumination
    xx = np.linspace(0, 1, W, dtype=np.float32)[None, :]
    yy = np.linspace(0, 1, H, dtype=np.float32)[:, None]
    th = rng.uniform(0, 2 * math.pi)
    light = 1 - prof["vig"] * ((xx - .5) ** 2 + (yy - .5) ** 2) * 1.2 - prof["grad"] * (xx * math.cos(th) + yy * math.sin(th) - .5)
    if prof["gutter"]:
        d = (xx * W) if pg.side == "R" else ((1 - xx) * W)
        light = light - prof["gutter"] * np.exp(-d / (0.075 * W))
    img *= np.clip(light, 0.2, 1.1)[..., None]
    if prof["warp"]:
        d = (np.arange(W) if pg.side == "R" else np.arange(W)[::-1]).astype(np.float32)
        dy = (prof["warp"] * np.exp(-d / (0.10 * W)) * (1 if pg.side == "R" else -1)).astype(np.int32)
        idx = np.clip(np.arange(H)[:, None] + dy[None, :], 0, H - 1)
        img = img[idx, np.arange(W)[None, :]]
    img = np.clip(img, 0, 1)
    # folds (letter folded in thirds)
    if prof["folds"]:
        for fy in (H // 3, 2 * H // 3):
            y = int(fy + rng.uniform(-20, 20))
            img[y:y + 2] *= .90
            img[y + 2:y + 5] = np.clip(img[y + 2:y + 5] * 1.03, 0, 1)
    im = Image.fromarray((img * 255).astype(np.uint8), "RGB")
    # punch holes
    lid = prof["lid"]
    if prof["punch"] and rng.random() < prof["punch"] + .0:
        d = ImageDraw.Draw(im)
        px = int(rng.uniform(52, 82))
        ys = [int(H * .13), int(H * .5), int(H * .87)] if rng.random() < .7 else [int(H * .5)]
        for yy_ in ys:
            yy_ += int(rng.uniform(-4, 4))
            d.ellipse([px - 26, yy_ - 26, px + 26, yy_ + 26], fill=(lid, lid, lid))
    # skew
    ang = rng.uniform(-prof["skew"], prof["skew"])
    im = im.rotate(ang, resample=Image.BICUBIC, fillcolor=(lid, lid, lid), translate=(rng.randint(-14, 14), rng.randint(-14, 14)))
    a = np.asarray(im, np.float32)
    # dark copier bands at edges
    if prof.get("bands"):
        for side in range(4):
            if rng.random() < .4:
                w0 = rng.uniform(5, 30)
                n = H if side < 2 else W
                edge = (nfield(rng, n, 1, 90)[0] * 0.25 + .85) * w0
                for i in range(int(edge.max()) + 1):
                    v = 1 - np.clip((edge - i) / 3, 0, 1) * 0.92
                    if side == 0:
                        a[:, i] *= v[:, None]
                    elif side == 1:
                        a[:, W - 1 - i] *= v[:, None]
                    elif side == 2:
                        a[i, :] *= v[:, None]
                    else:
                        a[H - 1 - i, :] *= v[:, None]
    # speckle noise
    sp = (g.random((H, W)) < prof["speckle"] * 0.5).astype(np.uint8) * 255
    spim = Image.fromarray(sp, "L").filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(.6))
    a *= (1 - np.asarray(spim, np.float32) / 255 * .85)[..., None]
    im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")
    d = ImageDraw.Draw(im)
    for _ in range(int(prof["dust"] * 0.5 * rng.uniform(.6, 1.4))):
        x, y = rng.uniform(0, W), rng.uniform(0, H)
        r = rng.uniform(.7, 2.4)
        v = int(rng.uniform(90, 175))
        d.ellipse([x - r, y - r * rng.uniform(.6, 1), x + r, y + r], fill=(v, v, v))
    for _ in range(prof["hair"]):
        if rng.random() < .6:
            x, y = rng.uniform(0, W), rng.uniform(0, H)
            pts = []
            for k in range(8):
                x += rng.uniform(-18, 22)
                y += rng.uniform(-10, 24)
                pts.append((x, y))
            d.line(pts, fill=(70, 66, 60), width=1)
    for _ in range(prof["streaks"]):
        if rng.random() < .65:
            x = rng.randint(30, W - 30)
            sw = rng.choice([1, 1, 2, 3])
            strip = np.asarray(im.crop((x, 0, x + sw, H)), np.float32) * rng.uniform(.84, .95)
            im.paste(Image.fromarray(strip.astype(np.uint8), "RGB"), (x, 0))
    if prof["gray"]:
        im = im.convert("L")
        if prof["contrast"]:
            lo, hi, gm = prof["contrast"]
            im = Image.fromarray(_levels(np.asarray(im, np.float32), lo, hi, gm).astype(np.uint8), "L")
    micro = prof.get("micro")
    if micro:
        arr = np.asarray(im, np.float32)
        arr += g.standard_normal(arr.shape).astype(np.float32) * 7
        im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "L")
        for _ in range(prof["streaks"]):
            x = rng.randint(20, W - 20)
            sub = np.asarray(im.crop((x, 0, x + 1, H)), np.float32) + rng.uniform(25, 50)
            im.paste(Image.fromarray(np.clip(sub, 0, 255).astype(np.uint8), "L"), (x, 0))
        if micro == "neg":
            im = ImageOps.invert(im)
        shrink = rng.uniform(.90, .95)
        sw_, sh_ = int(W * shrink), int(H * shrink)
        small = im.resize((sw_, sh_), Image.LANCZOS)
        canvas = Image.new("L", (W, H), 10 if micro == "pos" else 8)
        canvas.paste(small, ((W - sw_) // 2 + rng.randint(-8, 8), (H - sh_) // 2 + rng.randint(-8, 8)))
        im = canvas
    b = prof["blur"] * 0.55
    im = im.filter(ImageFilter.GaussianBlur(b))
    return im


def jpeg_bytes(im, prof, rng):
    q = rng.randint(*prof["jpeg"])
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=q, optimize=True)
    return buf.getvalue(), im.mode, im.size, q


def write_pdf(path, pages, info):
    """pages: list of (jpeg_bytes, mode, (w_px, h_px)). Page units: 150 dpi -> pt = px*72/150."""
    objs = []

    def add(b):
        objs.append(b)
        return len(objs)

    cat_id = add(b"")
    pages_id = add(b"")
    kids = []
    for jb, mode, (w, h) in pages:
        wp, hp = w * 72.0 / DPI, h * 72.0 / DPI
        cs = b"/DeviceGray" if mode == "L" else b"/DeviceRGB"
        img_id = add(b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace %s /BitsPerComponent 8 /Filter /DCTDecode /Length %d >>\nstream\n" % (w, h, cs, len(jb)) + jb + b"\nendstream")
        content = ("q %.2f 0 0 %.2f 0 0 cm /Im0 Do Q" % (wp, hp)).encode()
        c_id = add(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
        p_id = add(("<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %.2f %.2f] /Resources << /XObject << /Im0 %d 0 R >> >> /Contents %d 0 R >>" % (pages_id, wp, hp, img_id, c_id)).encode())
        kids.append(p_id)
    objs[pages_id - 1] = ("<< /Type /Pages /Kids [%s] /Count %d >>" % (" ".join("%d 0 R" % k for k in kids), len(kids))).encode()
    objs[cat_id - 1] = ("<< /Type /Catalog /Pages %d 0 R >>" % pages_id).encode()
    info_id = add(("<< /Producer (%s) /Creator (%s) /CreationDate (D:%s) >>" % (info["producer"], info["producer"], info["date"])).encode())
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offs = []
    for i, b in enumerate(objs, 1):
        offs.append(out.tell())
        out.write(b"%d 0 obj\n" % i + b + b"\nendobj\n")
    xr = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for o in offs:
        out.write(b"%010d 00000 n \n" % o)
    out.write(b"trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, cat_id, info_id, xr))
    with open(path, "wb") as fh:
        fh.write(out.getvalue())

# ----------------------------------------------------------------------------
# Instruments, references, style configs
# ----------------------------------------------------------------------------
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
          "October", "November", "December"]
COUNTY = "Reeves"
CLERKS = {  # fictional county clerks by era
    1889: "J. T. Stroud", 1900: "H. B. Odom", 1912: "R. A. Lindley", 1922: "Mabel E. Teague",
    1940: "Dolores A. Quintero", 1960: "W. L. Hargrove", 1980: "Anita R. Salcido", 2000: "Teresa M. Whitlow",
}
NOTARIES = ["Carl W. Beasley", "Ruth M. Anders", "Elias Q. Navarro", "Opal J. Kirkwood", "Harold T. Sims",
            "Juanita C. Rios", "Delbert R. Moats", "Patricia L. Ennis", "Kenneth A. Voss", "Lupe S. Ortega"]
COUNTIES_NOTARY = ["Reeves", "Reeves", "Ward", "Pecos", "Reeves"]


def clerk_for(year):
    k = max(y for y in CLERKS if y <= year)
    return CLERKS[k]


def d_long(d):
    return "%s %d, %d" % (MONTHS[d.month - 1], d.day, d.year)


def ordn(n):
    if 10 <= n % 100 <= 20:
        return "%dth" % n
    return "%d%s" % (n, {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th"))


def d_day(d, comma=True):
    return "%s day of %s%s %d" % (ordn(d.day), MONTHS[d.month - 1], "," if comma else "", d.year)


def d_short(d):
    return "%d/%d/%d" % (d.month, d.day, d.year)


def d_iso(d):
    return d.isoformat()


def time_s(rng):
    h = rng.randint(8, 16)
    m = rng.choice([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
    ap = "A.M." if h < 12 else "P.M."
    return "%d:%02d %s" % (h if h <= 12 else h - 12, m, ap)


def hl(txt, kind):
    return "<h:%s>%s</h>" % (kind, txt)


@dataclass
class Inst:
    id: str
    kind: str
    type_name: str
    slug: str
    ex: dt.date
    rec: dt.date
    series: str
    style: str
    med: str
    P: dict = field(default_factory=dict)
    ref: dict = field(default_factory=dict)
    blocks: list = field(default_factory=list)
    key: dict = field(default_factory=dict)
    traps: list = field(default_factory=list)
    hard_fields: dict = field(default_factory=dict)
    margin_notes: list = field(default_factory=list)
    n: int = 0

    @property
    def era(self):
        y = self.rec.year
        return "A" if y < 1923 else "B" if y < 1980 else "C"


SERIES_NAME = {
    "GLO": "Deed Records", "DR": "Deed Records", "DTR": "Deed of Trust Records", "OGL": "Oil and Gas Lease Records",
    "MR": "Miscellaneous Records", "PM": "Probate Minutes", "OPR": "Official Public Records", "DOC": "Official Public Records",
    "CM": "Civil Minutes",
}
SERIES_ABBR = {"GLO": "D.R.", "DR": "D.R.", "DTR": "D.T.R.", "OGL": "O.G.L.R.", "MR": "Misc. Rec.", "PM": "Prob. Min.",
               "OPR": "O.P.R.", "DOC": "O.P.R.", "CM": "Civ. Min."}


def assign_refs(insts, rng):
    used = set()
    seq = {}
    for I in sorted(insts, key=lambda i: (i.rec, i.id)):
        y = I.rec.year
        s = I.series
        if s == "DOC":
            seq[y] = seq.get(y, rng.randint(180, 2400)) + rng.randint(11, 400)
            no = "%d-%07d" % (y, seq[y])
            I.ref = dict(inst_no=no, text="Instrument No. %s, Official Public Records of %s County, Texas" % (no, COUNTY),
                         short="Instr. No. %s, O.P.R.R.C.T." % no, vol=None, page=None, series=s)
            continue
        if s in ("GLO", "DR"):
            vol = max(1, (y - 1884) // 2) if y < 1980 else (y - 1980) // 2 + 60
        elif s == "DTR":
            vol = max(1, (y - 1889) // 6 + 1) if y < 1980 else 40 + (y - 1980) // 3
        elif s == "OGL":
            vol = max(1, (y - 1926) // 3 + 1)
        elif s == "MR":
            vol = max(1, (y - 1895) // 7 + 1)
        elif s == "PM":
            vol = max(1, (y - 1880) // 9 + 1)
        elif s == "CM":
            vol = max(1, (y - 1930) // 7 + 3)
        else:  # OPR
            vol = (y - 1979) * 26 + rng.randint(3, 24)
        while True:
            page = rng.randint(4, 640 if y < 1980 else 900)
            if (s, vol, page) not in used:
                used.add((s, vol, page))
                break
        sname = SERIES_NAME[s]
        I.ref = dict(vol=vol, page=page, series=s, inst_no=None,
                     text="Vol. %d, Page %d, %s of %s County, Texas" % (vol, page, sname, COUNTY),
                     short="Vol. %d, Pg. %d, %s" % (vol, page, SERIES_ABBR[s]))


class Registry:
    def __init__(self):
        self.items = {}

    def __getitem__(self, k):
        return self.items[k]

    def text(self, k):
        return self.items[k].ref["text"]

    def short(self, k):
        return self.items[k].ref["short"]


# ---- style configuration ------------------------------------------------------
def make_cfg(I, rng):
    st = I.style
    sp = I.P.get("spacing", "double")
    if st == "longhand":
        fam = "snell" if I.rec.year < 1903 or (I.rec.year >= 1912 and I.rec.year < 1918) else "chancery"
        size = 46 if fam == "snell" else 40
        return Cfg(family=fam, size=size, line_h=60, left=235, right=105, top=215, bottom=140, mode="hand", mask="ink",
                   align="left", base_off=.84, first_indent=80, ruled=True, jit=1.0)
    if st == "typed":
        fam = I.P.get("family") or ("courier" if (I.rec.year // 7 + _h(I.id)) % 3 else "amtype")
        lh = {"double": 50, "one_half": 38, "single": 28}[sp]
        size = 25 if fam == "courier" else 24
        return Cfg(family=fam, size=size, line_h=lh, left=190, right=130, top=205, bottom=190, mode="typed", mask="ink",
                   align="left", base_off=.72, first_indent=75 if sp != "single" else 60, jit=1.0,
                   para_gap=0 if sp == "double" else 12)
    if st == "form":
        return Cfg(family="times", size=20, line_h=25, left=105, right=105, top=170, bottom=150, mode="print", mask="print",
                   fill_family="courier", fill_size=21, fill_mask="ink", align="justify", base_off=.74, para_gap=5)
    return Cfg(family="times", size=25, line_h=33, left=150, right=150, top=200, bottom=175, mode="print", mask="print",
               align="justify", base_off=.74, para_gap=11, first_indent=0)


# ---- generic text helpers -------------------------------------------------------
def archaic(I):
    return I.style == "longhand"


def pron(sign_n):
    return ("he", "his", "him") if sign_n == 1 else ("they", "their", "them")


def legal_text(parts):
    return parts


LEGAL_TRACT = ("Section 22, Block 53, Township 7, Texas and Pacific Railway Company Survey, "
               "Reeves County, Texas, Abstract No. 4172")
LEGAL_ALL = "all of " + LEGAL_TRACT + ", containing 640 acres, more or less"
LEGAL_E2 = "the East Half (E/2) of " + LEGAL_TRACT + ", containing 320 acres, more or less"
LEGAL_W2 = "the West Half (W/2) of " + LEGAL_TRACT + ", containing 320 acres, more or less"
LEGAL_N2W2 = "the North Half of the West Half (N/2 of W/2) of " + LEGAL_TRACT + ", containing 160 acres, more or less"
LEGAL_S2W2 = "the South Half of the West Half (S/2 of W/2) of " + LEGAL_TRACT + ", containing 160 acres, more or less"
LEGAL_SECTION21 = "the East Half (E/2) of Section 21, Block 53, Township 7, Texas and Pacific Railway Company Survey, Reeves County, Texas, Abstract No. 4170, containing 320 acres, more or less"


def meters_and_bounds(rng, corner="the Northwest corner", acres=160, tag="TRACT"):
    """Plausible closing traverse for a rectangle-ish tract (cosmetic)."""
    w = 2640.0
    h = round(acres * 43560 / w, 2)
    b1 = "N %d\u00b0%02d'%02d\" E" % (89, rng.randint(40, 59), rng.randint(0, 59))
    b2 = "S %d\u00b0%02d'%02d\" E" % (0, rng.randint(5, 25), rng.randint(0, 59))
    b3 = "S %d\u00b0%02d'%02d\" W" % (89, rng.randint(40, 59), rng.randint(0, 59))
    b4 = "N %d\u00b0%02d'%02d\" W" % (0, rng.randint(5, 25), rng.randint(0, 59))
    mon = rng.choice(["a 1/2\" iron rod found", "a 5/8\" iron rod with cap set", "a concrete monument found", "a mesquite post found"])
    return ("BEGINNING at %s at %s of said Section 22; THENCE %s, along the north line of said Section, %.2f feet to %s; "
            "THENCE %s, %.2f feet to a 1/2\" iron rod set; THENCE %s, %.2f feet to a 1/2\" iron rod set; "
            "THENCE %s, %.2f feet to the PLACE OF BEGINNING, containing %d acres of land, more or less."
            % (mon, corner, b1, w + rng.uniform(-3, 3), rng.choice(["a 1/2\" iron rod set", "a fence corner post found"]),
               b2, h + rng.uniform(-2, 2), b3, w + rng.uniform(-3, 3), b4, h + rng.uniform(-2, 2), acres))


def mb_exhibit(rng, legal, corner, acres):
    return "Being %s, and being more particularly described by metes and bounds as follows: %s" % (legal, meters_and_bounds(rng, corner, acres))


# ---- ack / sig / certificate blocks --------------------------------------------
def ack_dict(I, rng, persons, ex_date=None, capacity=None, privy=None, defect=None, notary=None, seal="round",
             company=None, county=None, corp=None):
    notary = notary or NOTARIES[rng.randrange(len(NOTARIES))]
    return dict(persons=persons, date=ex_date or I.ex, capacity=capacity, privy=privy, defect=defect,
                notary=notary, seal=seal, county=county or rng.choice(COUNTIES_NOTARY), corp=corp)


def ack_text(I, a):
    """Return (markup string, pronoun) for acknowledgment body."""
    pers = a["persons"]
    names = " and ".join(pers)
    cap = a.get("capacity")
    modern = I.rec.year >= 1975
    if a.get("corp"):
        body = ("BEFORE ME, the undersigned authority, on this day personally appeared %s, %s of %s, a %s, known to me "
                "to be the person whose name is subscribed to the foregoing instrument, and acknowledged to me that "
                "he executed the same for the purposes and consideration therein expressed, in the capacity therein "
                "stated, and as the act and deed of said corporation." % (names, cap or "Vice President", a["corp"][0], a["corp"][1]))
    elif a.get("privy"):
        body = ("BEFORE ME, the undersigned authority, on this day personally appeared %s, known to me to be the person "
                "whose name is subscribed to the foregoing instrument, and acknowledged to me that he executed the same "
                "for the purposes and consideration therein expressed. And the said %s, wife of the said %s, having been "
                "examined by me privily and apart from her husband, and having the same fully explained to her, she, the "
                "said %s, acknowledged such instrument to be her act and deed, and declared that she had willingly signed "
                "the same for the purposes and consideration therein expressed, and that she did not wish to retract it."
                % (a["privy"][1], a["privy"][0], a["privy"][1], a["privy"][0]))
    else:
        s = "s" if len(pers) > 1 else ""
        body = ("BEFORE ME, the undersigned authority, on this day personally appeared %s, known to me to be the person%s "
                "whose name%s %s subscribed to the foregoing instrument, and acknowledged to me that %s executed the same "
                "for the purposes and consideration therein expressed%s." % (names, s, s, "are" if s else "is",
                                                                              "they" if s else "he",
                                                                              (", in the capacity therein stated" if cap else "")))
    if a.get("defect") == "no_date":
        tail = "GIVEN UNDER MY HAND AND SEAL OF OFFICE this the ______ day of ________________, A.D. 19____."
    else:
        tail = "GIVEN UNDER MY HAND AND SEAL OF OFFICE this the %s." % d_day(a["date"])
    return body, tail


def run_blocks(flow, I, blocks, rng):
    cfg = flow.cfg
    st = I.style
    for b in blocks:
        op = b[0]
        if op == "pb":
            flow.new_page()
        elif op == "gap":
            flow.space(b[1])
        elif op == "title":
            _title(flow, I, b[1], b[2] if len(b) > 2 else 0)
        elif op == "p":
            opts = b[2] if len(b) > 2 else {}
            flow.para(b[1], **opts)
        elif op == "pc":     # centered
            flow.para(b[1], align="center", **(b[2] if len(b) > 2 else {}))
        elif op == "cap":
            _caption(flow, I, b[1], b[2], b[3] if len(b) > 3 else "")
        elif op == "sig":
            _signatures(flow, I, b[1], rng)
        elif op == "ack":
            _ack(flow, I, b[1], rng)
        elif op == "plat":
            flow.need(520)
            y = flow.y
            plat_sketch(flow.page, rng, cfg.left, y, PW - cfg.left - cfg.right, 480, b[1])
            flow.y = y + 500
        elif op == "table":
            _table(flow, b[1], b[2], b[3] if len(b) > 3 else {})
        elif op == "cert":
            _clerk_cert(flow, I, rng)
        elif op == "typed":
            c = Cfg(**{**cfg.__dict__})
            if st == "form":
                c.family, c.size, c.line_h, c.mode, c.mask, c.align, c.left, c.right = "courier", 23, 36, "typed", "ink", "left", 130, 110
                c.first_indent = 0
            else:
                c.align = "justify"
            for para in b[1]:
                flow.para(para, cfg=c, gap=12)
        elif op == "jurat":
            _ack(flow, I, b[1], rng)
        elif op == "hr":
            flow.need(20)
            flow.rule(dy=8)
            flow.y += 18
        elif op == "tab":
            flow.tabline(b[1])
        else:
            raise ValueError(op)


def _title(flow, I, text, size_boost=0):
    cfg = flow.cfg
    st = I.style
    if st == "longhand":
        c = Cfg(**{**cfg.__dict__, "family": "snellb", "size": 56, "line_h": cfg.line_h * 1})
        c.align = "center"
        flow.need(cfg.line_h * 2)
        flow.para(text.title() if text.isupper() else text, align="center", cfg=c, gap=cfg.line_h // 2 if False else 0)
        return
    c = Cfg(**{**cfg.__dict__})
    if st == "wp":
        c.size, c.line_h = 30 + size_boost, 40
        c.family = "timesb"
        flow.need(100)
        flow.para(text, align="center", cfg=c, gap=22)
    elif st == "form":
        c.size, c.line_h = 30 + size_boost, 38
        c.family = "timesb"
        flow.para(text, align="center", cfg=c, gap=8)
    else:
        flow.need(cfg.line_h * 3)
        flow.para("<b>%s</b>" % text, align="center", gap=cfg.line_h // 2)


def _caption(flow, I, state, county, right):
    cfg = flow.cfg
    st = I.style
    if st == "longhand":
        flow.para("The State of Texas, } County of %s. } %s" % (county.replace("COUNTY OF ", "").title(),
                  right.title() if right.isupper() else right), align="left", first=0)
        return
    mid = 330
    flow.tabline([(0, state, "l"), (mid, "\u00a7", "c"), (mid + 70, "", "l")])
    flow.tabline([(0, "", "l"), (mid, "\u00a7", "c"), (mid + 70, right, "l")])
    flow.tabline([(0, county, "l"), (mid, "\u00a7", "c")])
    flow.space(flow.cfg.line_h // 2)


def _signatures(flow, I, signers, rng):
    cfg = flow.cfg
    st = I.style
    flow.space(cfg.line_h // 2)
    if st == "longhand":
        for s in signers:
            nm = s["name"]
            flow.need(cfg.line_h)
            flow.para("(Signed)   <b>%s</b>%s" % (nm, (" (his mark)" if s.get("mark") else "")), align="left", first=210)
        return
    for s in signers:
        flow.need(130)
        y = flow.y + 70
        x0 = int(PW * 0.47)
        if s.get("scrawl", True):
            signature(flow.page, rng, x0 + 14, y - 14, officer(s["name"]), width=int(PW - cfg.right - x0 - 40), mark=s.get("mark", False))
        flow.page.d(cfg.mask if st != "wp" else "print").line([(x0, y), (PW - cfg.right, y)], fill=230, width=2)
        flow.y = y + 12
        cap = s["name"] + ("" if not s.get("cap") else ", " + s["cap"])
        flow.para(cap.upper() if st == "typed" else cap, align="left", left=x0 - cfg.left, gap=cfg.line_h // 3 if st != "wp" else 6)


def officer(name):
    return name.split(", by ")[-1]


def persons_of(P):
    return [officer(s[0]).upper() for s in P["sign"]]


def _ack(flow, I, a, rng):
    cfg = flow.cfg
    st = I.style
    if a.get("defect") == "no_ack":
        return
    body, tail = ack_text(I, a)
    if a.get("jurat"):
        body = None
        tail = "SUBSCRIBED AND SWORN TO BEFORE ME by the above-named affiant(s) on this the %s." % d_day(a["date"])
    flow.space(cfg.line_h // 2)
    flow.need(cfg.line_h * 9)
    st_text = "THE STATE OF TEXAS" if st != "longhand" else "The State of Texas,"
    if st == "longhand":
        flow.para("The State of Texas, County of %s." % a["county"], align="left", first=0)
        body = body.replace("BEFORE ME, the undersigned authority, on this day personally appeared", "Before me, the undersigned authority, on this day personally appeared")
        body = body.replace("GIVEN UNDER MY HAND AND SEAL OF OFFICE", "Given under my hand and seal of office")
        if body:
            flow.para(body, first=80)
        flow.para(tail, first=80)
    else:
        flow.tabline([(0, st_text, "l"), (330, "\u00a7", "c")])
        flow.tabline([(0, "COUNTY OF %s" % a["county"].upper(), "l"), (330, "\u00a7", "c")])
        if body:
            flow.para(body, first=60, gap=6)
        flow.para(tail, first=60, gap=4)
    flow.need(cfg.line_h * 4)
    y = flow.y + cfg.line_h * 0.6
    x0 = int(PW * 0.47)
    notary = a["notary"]
    if a.get("defect") != "no_notary_sig":
        signature(flow.page, rng, x0 + 20, y + 40, notary, width=int(PW - cfg.right - x0 - 60))
    flow.page.d(cfg.mask if st != "wp" else "print").line([(x0, y + 48), (PW - cfg.right, y + 48)], fill=230, width=2)
    flow.y = y + 50
    flow.para("Notary Public in and for %s County, Texas" % a["county"], left=x0 - cfg.left, align="left", gap=0)
    if st == "longhand":
        yy = flow.y - cfg.line_h * 2.0
        if a.get("seal", "round") not in (None, "none"):
            flow.page.d("ink").ellipse([cfg.left, yy - 20, cfg.left + 120, yy + 80], outline=235, width=3)
            flow.hand_text(flow.page, cfg.left + 14, yy + 40, "Seal", "snell", Cfg(size=34, mask="ink"))
        flow.para("%s, Notary Public" % notary, left=x0 - cfg.left, align="left")
        return
    exp = dt.date(a["date"].year + 2, 6, 1) if a["date"].year < 1980 else dt.date(a["date"].year + 3, rng.randint(1, 12), rng.randint(1, 28))
    if a.get("defect") != "no_comm":
        flow.para("My commission expires: %s" % d_long(exp), left=x0 - cfg.left, align="left", gap=0)
    if a.get("seal", "round") == "round" and a.get("defect") != "no_seal":
        round_seal(flow.page, rng, cfg.left + 140, int(y + 52), 98, "NOTARY PUBLIC", "STATE OF TEXAS", strength=rng.uniform(.65, .95))
    elif a.get("seal") == "ink" and a.get("defect") != "no_seal":
        notary_ink_stamp(flow.page, rng, cfg.left + 10, int(y + 4), notary, d_short(exp))
    flow.space(10)


def _table(flow, rows, xs, opts):
    cfg = flow.cfg
    xs = [0, 330, 955] if (cfg.mode == "typed") else [0, 420, 955]
    rows = [r[:3] for r in rows]
    opts = dict(opts, align=["l", "l", "r"])
    for ri, row in enumerate(rows):
        flow.need(cfg.line_h)
        items = []
        for ci, cell in enumerate(row):
            al = opts.get("align", ["l"] * len(xs))[ci]
            items.append((xs[ci], ("<b>%s</b>" % cell) if ri == 0 and opts.get("header", True) else cell, al))
        flow.tabline(items)
        if ri == 0 and opts.get("header", True):
            flow.page.d(cfg.mask).line([(cfg.left, flow.y - 4), (PW - cfg.right, flow.y - 4)], fill=230, width=2)
    flow.space(cfg.line_h // 2)


def _clerk_cert(flow, I, rng):
    cfg = flow.cfg
    r = I.ref
    cl = clerk_for(I.rec.year)
    flow.space(cfg.line_h // 2)
    flow.need(cfg.line_h * 8)
    where = ("Vol. %d, Page %d of the %s of %s County, Texas" % (r["vol"], r["page"], SERIES_NAME[r["series"]], COUNTY)
             if r.get("vol") else "Instrument No. %s of the Official Public Records of %s County, Texas" % (r["inst_no"], COUNTY))
    if I.style == "longhand":
        txt = ("Filed for record the %s, at %s o'clock %s, and duly recorded the %s in %s. Witness my hand and the "
               "seal of the County Court at office in Pecos, Texas, the day and year last above written. "
               "%s, Clerk County Court, %s County, Texas. By ________, Deputy."
               % (d_day(I.rec, False), I.P.get("hour", "2"), "P.M.", d_day(I.rec, False), where, cl, COUNTY))
        flow.para(txt, first=0)
        return
    txt = ("THE STATE OF TEXAS, COUNTY OF %s. I, %s, County Clerk of %s County, Texas, do hereby certify that the "
           "foregoing instrument of writing, with its certificate of authentication, was filed for record in my office on the "
           "%s, at %s, and duly recorded on the %s in %s. WITNESS MY HAND AND SEAL OF OFFICE at Pecos, Texas, the day and year "
           "last above written. %s, County Clerk, %s County, Texas. By ______________, Deputy."
           % (COUNTY.upper(), cl.upper(), COUNTY, d_day(I.rec), I.P.get("time", "10:15 A.M."), d_day(I.rec), where, cl, COUNTY))
    flow.para(txt, first=60, gap=4)

# ----------------------------------------------------------------------------
# Builders: each returns the block list and fills I.key / I.traps
# ----------------------------------------------------------------------------
KEY_FIELDS = ["DOC TYPE", "DATE EXECUTED", "DATE RECORDED", "RECORDING REF", "GRANTOR", "GRANTEE", "LEGAL DESC",
              "SURFACE", "MINERALS", "ROYALTY/NPRI", "TERM", "AFTER-ACQUIRED TITLE", "FRACTION CONVEYED",
              "RESERVATIONS", "WARRANTY", "ACKNOWLEDGMENT", "ISSUES", "CONFIDENCE"]


def base_key(I):
    I.key = {
        "DOC TYPE": I.type_name, "DATE EXECUTED": d_long(I.ex), "DATE RECORDED": d_long(I.rec),
        "RECORDING REF": I.ref["text"], "GRANTOR": "", "GRANTEE": "", "LEGAL DESC": "", "SURFACE": "no",
        "MINERALS": "no", "ROYALTY/NPRI": "no", "TERM": "not applicable", "AFTER-ACQUIRED TITLE": "no",
        "FRACTION CONVEYED": "not applicable", "RESERVATIONS": "none stated", "WARRANTY": "not applicable",
        "ACKNOWLEDGMENT": "yes", "ISSUES": "", "CONFIDENCE": "",
    }


def S(I, old, new):
    return new if archaic(I) else old


def witness_line(I, n=1, d=None, hard_day=False):
    d = d or I.ex
    if hard_day:
        return "WITNESS %s HAND%s this the %s day of %s, %d." % ("OUR" if n > 1 else "MY", "S" if n > 1 else "", hl(ordn(d.day), "smudge"), MONTHS[d.month - 1], d.year)
    if archaic(I):
        return "Witness %s hand%s this %s." % ("our" if n > 1 else "my", "s" if n > 1 else "", d_day(d, False))
    return "WITNESS %s HAND%s this the %s." % ("OUR" if n > 1 else "MY", "S" if n > 1 else "", d_day(d))


def signers_of(P):
    return [dict(name=n[0], cap=(n[1] if len(n) > 1 else None), mark=(len(n) > 2 and n[2] == "mark")) for n in P["sign"]]


def deed_core(I, R, rng, title, warranty, grant_phrase, legal, interest_clause="", reservation=None, exceptions=None,
              after_acq=False, extra=None, cons=None, surface="yes", minerals="yes - full", royalty="no", term="perpetual",
              frac=None, key_extra=None, ack=None, defect_note=None, recital=None, subj_to=None):
    P = I.P
    base_key(I)
    old = archaic(I)
    exhibit_txt = None
    if P.get("exhibit_mb"):
        exhibit_txt = mb_exhibit(rng, legal, P["exhibit_mb"][0], P["exhibit_mb"][1])
        legal_in_text = "the real property described on Exhibit \"A\" attached hereto and incorporated herein for all purposes"
    else:
        legal_in_text = legal
    gor, gee = P["gor"], P["gee"]
    n_sign = len(P["sign"])
    cons = cons or P.get("cons") or "Ten and No/100 Dollars ($10.00) and other good and valuable consideration"
    blocks = [("cap", "THE STATE OF TEXAS", "COUNTY OF %s" % COUNTY.upper(), "KNOW ALL MEN BY THESE PRESENTS:"), ("title", title)]
    heard = "have" if P.get("plural", False) else "has"
    intro = ("%s That %s, %s, for and in consideration of %s to %s in hand paid by %s, %s, the receipt of which is hereby "
             "acknowledged, %s %s" % ("" if old else "", gor, P.get("gor_res", "of %s County, Texas" % COUNTY), cons,
                                      "Grantor", gee, P.get("gee_res", "of %s County, Texas" % COUNTY),
                                      heard, grant_phrase))
    if recital:
        intro = recital + " " + intro
    blocks.append(("p", "%s %s %s" % (intro, interest_clause, legal_in_text) + ("." if not legal_in_text.endswith(".") else ""),))
    if reservation:
        blocks.append(("p", reservation))
    if exceptions:
        blocks.append(("p", exceptions))
    if subj_to:
        blocks.append(("p", subj_to))
    for e in (extra or []):
        blocks.append(("p", e))
    if warranty == "general":
        gee_h = "Grantee, %s heirs and assigns" % ("his" if " and " not in gee else "their") if old else "Grantee, Grantee's heirs and assigns"
        blocks.append(("p", "TO HAVE AND TO HOLD the premises above described, together with all and singular the rights and "
                            "appurtenances thereto in anywise belonging, unto the said %s forever; and %s do hereby bind %s, %s "
                            "heirs, executors and administrators, to WARRANT AND FOREVER DEFEND all and singular the said premises "
                            "unto the said Grantee, against every person whomsoever lawfully claiming or to claim the same or any "
                            "part thereof." % (gee_h, "I" if n_sign == 1 else "we", "myself" if n_sign == 1 else "ourselves",
                                               "my" if n_sign == 1 else "our")))
        wtype = "full"
    elif warranty == "special":
        blocks.append(("p", "TO HAVE AND TO HOLD the premises above described, together with all and singular the rights and "
                            "appurtenances thereto in anywise belonging, unto Grantee, Grantee's successors and assigns forever. "
                            "Grantor binds Grantor and Grantor's successors to WARRANT AND FOREVER DEFEND all and singular the "
                            "premises unto Grantee, Grantee's successors and assigns, against every person whomsoever lawfully "
                            "claiming or to claim the same or any part thereof, by, through or under Grantor, but not otherwise."))
        wtype = "special"
    else:
        blocks.append(("p", "TO HAVE AND TO HOLD all of Grantor's right, title and interest, if any, in and to the premises "
                            "above described unto Grantee, Grantee's heirs and assigns forever. This conveyance is made WITHOUT "
                            "WARRANTY of any kind, express or implied, and Grantor makes no representation as to the extent "
                            "or validity of Grantor's title."))
        wtype = "quitclaim"
    if after_acq:
        blocks.append(("p", "It is further agreed that if Grantor should hereafter acquire any additional right, title or interest "
                            "in or to the above described premises, such after-acquired title shall inure to the benefit of "
                            "Grantee, Grantee's heirs and assigns, and Grantor will, upon request, execute any further instrument "
                            "reasonably required to confirm the same."))
    blocks.append(("p", witness_line(I, n_sign, hard_day=bool(P.get("hard_exec_day"))), ))
    blocks.append(("sig", signers_of(P)))
    a = ack or ack_dict(I, rng, P.get("ack_persons") or persons_of(P), privy=P.get("privy"), defect=P.get("ack_defect"),
                        corp=P.get("ack_corp"), capacity=(P["sign"][0][1] if len(P["sign"][0]) > 1 else None),
                        seal="round" if I.rec.year < 1975 else "ink")
    if a is not None:
        blocks.append(("ack", a))
    if exhibit_txt:
        blocks.append(("pb",))
        blocks.append(("title", "EXHIBIT \"A\""))
        blocks.append(("p", exhibit_txt, dict(align="left")))
    k = I.key
    k.update({"GRANTOR": gor, "GRANTEE": gee, "LEGAL DESC": exhibit_txt or legal, "SURFACE": surface, "MINERALS": minerals,
              "ROYALTY/NPRI": royalty, "TERM": term, "AFTER-ACQUIRED TITLE": "yes" if after_acq else "no",
              "FRACTION CONVEYED": frac or "all of Grantor's interest as described (no fraction stated)",
              "RESERVATIONS": strip_markup(reservation) if reservation else "none stated", "WARRANTY": wtype,
              "ACKNOWLEDGMENT": "no" if (a is None or a.get("defect") == "no_ack") else "yes"})
    if a and a.get("defect") == "no_privy" or P.get("ack_defect") == "no_privy":
        k["ACKNOWLEDGMENT"] = "yes (certificate omits the wife's separate and privy examination)"
    if key_extra:
        k.update(key_extra)
    return blocks


def finish_issues(I):
    I.key["ISSUES"] = "; ".join(I.traps) if I.traps else "none noted"


# ----- kinds --------------------------------------------------------------------
def b_patent(I, R, rng):
    P = I.P
    base_key(I)
    legal = P["legal"]
    blocks = [("title", "THE STATE OF TEXAS"), ("pc", "GENERAL LAND OFFICE"),
              ("p", "PATENT No. <fill>%s</fill>, Volume <fill>%s</fill>" % (P["no"], P["vol"]), dict(align="center", gap=6)),
              ("p", "Know All Men By These Presents: THAT, WHEREAS, by virtue of Land Certificate No. %s, issued under the "
                    "laws of the State of Texas to %s, and the same having been duly surveyed and the field notes thereof "
                    "returned to and filed in the General Land Office, as the law requires; NOW, THEREFORE, the State of Texas, "
                    "by and through the Commissioner of the General Land Office, in consideration of the premises, has GRANTED "
                    "and by these presents does GRANT unto the said %s and %s heirs and assigns forever, the following "
                    "described land, to-wit: %s." % (P["cert"], P["gee"], P["gee"], "his", legal)),
              ("p", "TO HAVE AND TO HOLD the said land, together with all and singular the rights, privileges and appurtenances "
                    "thereunto belonging, unto the said %s and %s heirs and assigns forever, subject to the conditions "
                    "and reservations of the laws of this State touching the school fund and the mineral rights as then provided "
                    "by law." % (P["gee"], "his")),
              ("p", "IN TESTIMONY WHEREOF, I, %s, Commissioner of the General Land Office, have hereunto signed my name and "
                    "caused the Seal of the General Land Office to be affixed, at the City of Austin, this %s." % (P["commissioner"], d_day(I.ex))),
              ("sig", [dict(name=P["commissioner"], cap="Commissioner General Land Office")])]
    I.key.update({"GRANTOR": "The State of Texas", "GRANTEE": P["gee"], "LEGAL DESC": legal, "SURFACE": "yes", "MINERALS": "yes - full (subject to statutory reservations)",
                  "FRACTION CONVEYED": "the entire tract, as described", "WARRANTY": "not applicable (sovereign grant)",
                  "ACKNOWLEDGMENT": "no", "TERM": "perpetual", "RESERVATIONS": "subject to the conditions and reservations of the laws of this State touching the school fund and the mineral rights as then provided by law"})
    I.traps += ["Sovereign patent; no acknowledgment is required. The mineral reservation language is general ('mineral rights as then provided by law') and does not state what was reserved."]
    I.P["no_cert"] = True
    return blocks


def b_warranty_deed(I, R, rng):
    P = I.P
    blocks = deed_core(I, R, rng, "WARRANTY DEED" if not archaic(I) else "Warranty Deed", "general",
                       P.get("grant", "GRANTED, SOLD and CONVEYED, and by these presents do GRANT, SELL and CONVEY unto the said Grantee"),
                       P["legal"], interest_clause=P.get("interest_clause", "all that certain tract or parcel of land situated in %s County, Texas, described as follows, to-wit:" % COUNTY),
                       reservation=P.get("reservation"), exceptions=P.get("exceptions"), after_acq=P.get("after_acq", False),
                       extra=P.get("extra"), surface=P.get("surface", "yes"), minerals=P.get("minerals", "yes - full"),
                       royalty=P.get("royalty", "no"), frac=P.get("frac"), ack=P.get("ack_obj"), subj_to=P.get("subj_to"),
                       cons=P.get("cons"))
    for t in P.get("traps", []):
        I.traps.append(t)
    return blocks


def b_special_warranty(I, R, rng):
    P = I.P
    blocks = deed_core(I, R, rng, "SPECIAL WARRANTY DEED", "special", "GRANTED, SOLD and CONVEYED, and by these presents does GRANT, SELL and CONVEY unto Grantee",
                       P["legal"], interest_clause=P.get("interest_clause", "the following described real property situated in %s County, Texas:" % COUNTY),
                       reservation=P.get("reservation"), exceptions=P.get("exceptions"), after_acq=P.get("after_acq", False),
                       surface=P.get("surface", "yes"), minerals=P.get("minerals", "yes - full"), frac=P.get("frac"),
                       subj_to=P.get("subj_to"), ack=P.get("ack_obj"), extra=P.get("extra"))
    I.traps += P.get("traps", [])
    return blocks


def b_quitclaim(I, R, rng):
    P = I.P
    blocks = deed_core(I, R, rng, "QUITCLAIM DEED", "quit", "QUITCLAIMED, and by these presents does QUITCLAIM unto Grantee",
                       P["legal"], interest_clause=P.get("interest_clause", "all of Grantor's right, title and interest, if any, in and to the following described real property situated in %s County, Texas:" % COUNTY),
                       reservation=P.get("reservation"), surface=P.get("surface", "unclear"), minerals=P.get("minerals", "unclear"),
                       frac=P.get("frac"), ack=P.get("ack_obj"), extra=P.get("extra"))
    I.traps += P.get("traps", [])
    return blocks


def b_mineral_deed(I, R, rng):
    P = I.P
    frac = P["frac"]
    blocks = deed_core(I, R, rng, "MINERAL DEED", "general" if P.get("warranty", "special") == "general" else "special",
                       "GRANTED, BARGAINED, SOLD and CONVEYED, and by these presents does GRANT, BARGAIN, SELL and CONVEY unto Grantee",
                       P["legal"], interest_clause=P["interest_clause"], reservation=P.get("reservation"), surface="no",
                       minerals=P["minerals"], frac=strip_markup(frac), after_acq=P.get("after_acq", False),
                       extra=P.get("extra"), subj_to=P.get("subj_to"), ack=P.get("ack_obj"))
    if P.get("warranty") == "quit":
        pass
    I.traps += P.get("traps", [])
    return blocks


def b_royalty_deed(I, R, rng):
    P = I.P
    blocks = deed_core(I, R, rng, P.get("title", "ROYALTY DEED"), "special",
                       "GRANTED, SOLD, CONVEYED and ASSIGNED, and by these presents does GRANT, SELL, CONVEY and ASSIGN unto Grantee",
                       P["legal"], interest_clause=P["interest_clause"], reservation=P.get("reservation"), surface="no", minerals="no",
                       royalty=P["royalty_key"], term=P.get("term", "perpetual"), frac=strip_markup(P["frac"]), after_acq=P.get("after_acq", False),
                       extra=P.get("extra"), ack=P.get("ack_obj"))
    I.traps += P.get("traps", [])
    return blocks


def b_surface_deed(I, R, rng):
    P = I.P
    blocks = deed_core(I, R, rng, "WARRANTY DEED (SURFACE ONLY)", "general",
                       "GRANTED, SOLD and CONVEYED, and by these presents do GRANT, SELL and CONVEY unto the said Grantee",
                       P["legal"], interest_clause=P["interest_clause"], reservation=P["reservation"], surface="yes", minerals="no",
                       frac=strip_markup(P["frac"]), ack=P.get("ack_obj"), extra=P.get("extra"))
    I.traps += P.get("traps", [])
    return blocks


def b_correction_deed(I, R, rng):
    P = I.P
    recital = ("This Correction Deed is made to correct that certain Warranty Deed dated %s, executed by Grantor to Grantee and recorded "
               "in %s (the \"Original Deed\"), in which the land was erroneously described as being in %s, whereas the land intended to be "
               "conveyed, and actually owned by Grantor, is located in %s, as correctly described below." %
               (d_long(R[P["orig"]].ex), R.text(P["orig"]), P["wrong"], P["right"]))
    blocks = deed_core(I, R, rng, "CORRECTION WARRANTY DEED (SURFACE ONLY)", "general",
                       "GRANTED, SOLD and CONVEYED, and by these presents do GRANT, SELL and CONVEY unto the said Grantee",
                       P["legal"], interest_clause=P["interest_clause"], reservation=P["reservation"], surface="yes", minerals="no",
                       frac=strip_markup(P["frac"]), ack=P.get("ack_obj"), recital=recital)
    I.traps += P.get("traps", [])
    return blocks


def plat_exhibit(t, P):
    t.append(("pb",))
    t.append(("title", "EXHIBIT \"A\""))
    t.append(("plat", P["plat"]))


def plat_exhibit(t, P):
    t.append(("pb",))
    t.append(("title", "EXHIBIT \"A\""))
    t.append(("plat", P["plat"]))


def b_partition(I, R, rng):
    P = I.P
    base_key(I)
    t = [("cap", "THE STATE OF TEXAS", "COUNTY OF %s" % COUNTY.upper(), "KNOW ALL MEN BY THESE PRESENTS:"), ("title", "PARTITION DEED")]
    t.append(("p", "That %s (the \"Parties\"), being the owners, as tenants in common, of %s (the \"Property\"), as heirs of Ruben D. Vandiver, deceased, "
                   "desire to partition the Property between themselves in kind, and have agreed as follows:" % (P["gor"], P["legal"])))
    t.append(("p", "1. %s shall have and hold in severalty, and the other Parties GRANT, SELL, CONVEY and QUITCLAIM unto him, all of the surface and all of the "
                   "oil, gas and other minerals owned by the Parties in and under %s." % (P["owner_a"], P["tract_a"])))
    t.append(("p", "2. %s shall have and hold, as tenants in common, and Ned R. Vandiver GRANTS, SELLS, CONVEYS and QUITCLAIMS unto them all of his surface and mineral "
                   "interest in, %s." % (P["owner_b"], P["tract_b"])))
    t.append(("p", "3. This partition is made subject to all valid and subsisting royalty, term royalty, overriding royalty and oil and gas leasehold interests "
                   "of record, which shall burden each tract in proportion to the interest of the owner thereof. Nothing herein shall be construed to "
                   "partition, merge, or convey any interest of a person who is not a Party."))
    t.append(("p", "4. This partition is made without warranty of title, except that each Party warrants that he or she has not conveyed or encumbered the interest hereby released."))
    t.append(("p", witness_line(I, 4)))
    t.append(("sig", signers_of(P)))
    t.append(("ack", ack_dict(I, rng, persons_of(P))))
    I.key.update({"GRANTOR": P["gor"], "GRANTEE": P["gee"], "LEGAL DESC": P["legal"], "SURFACE": "yes", "MINERALS": "yes - the Parties' undivided interests, partitioned in kind",
                  "FRACTION CONVEYED": "partition in kind: %s to %s; %s to %s" % (P["tract_a"], P["owner_a"], P["tract_b"], P["owner_b"]),
                  "RESERVATIONS": "subject to all valid and subsisting royalty, term royalty, overriding royalty and oil and gas leasehold interests of record",
                  "WARRANTY": "quitclaim", "TERM": "perpetual"})
    if P.get("plat"):
        plat_exhibit(t, P)
    I.traps += P.get("traps", [])
    return t

# ----------------------------------------------------------------------------
# Builders (continued): leases, assignments, releases, liens, easements, estates
# ----------------------------------------------------------------------------
def rel_note(I):
    r = I.ref
    return ("Vol. %d Pg. %d" % (r["vol"], r["page"])) if r.get("vol") else ("Inst. No. %s" % r["inst_no"])


def lease_paras(p):
    f = lambda t: "<fill>%s</fill>" % t
    return [
        "THIS AGREEMENT made this %s, between %s, whose address is %s, hereinafter called Lessor (whether one or more), "
        "and %s, hereinafter called Lessee:" % (f(p["date_txt"]), f(p["lessor"]), f(p["addr"]), f(p["lessee"])),
        "1. Lessor, in consideration of %s in hand paid, receipt of which is hereby acknowledged, and of the royalties herein "
        "provided and of the agreements of Lessee herein contained, hereby grants, leases and lets exclusively unto Lessee for "
        "the purpose of investigating, exploring, prospecting, drilling and operating for and producing oil and gas, laying "
        "pipe lines, building roads, tanks, power stations, telephone lines and other structures thereon to produce, save, "
        "take care of, treat, transport and own said products, and housing its employees, the following described land in "
        "%s County, Texas, to-wit: %s %s containing %s acres, more or less, and including all interests therein which Lessor "
        "may hereafter acquire by reversion, prescription or otherwise." % (f(p["bonus"]), f(COUNTY), f(p["legal"]), "", f(p["acres"])),
        "2. Subject to the other provisions herein contained, this lease shall be for a term of %s years from this date (called "
        "\"primary term\") and as long thereafter as oil or gas is produced from said land or from land with which said land is "
        "pooled hereunder." % f(p["term_txt"]),
        "3. The royalties to be paid by Lessee are: (a) on oil, and other liquid hydrocarbons saved at the wells, %s of that "
        "produced and saved from said land, same to be delivered at the wells or to the credit of Lessor into the pipe line "
        "to which the wells may be connected; (b) on gas, including casinghead gas or other gaseous substance, produced from "
        "said land and sold or used off the premises or in the manufacture of gasoline or other products, the market value at "
        "the well of %s of the gas so sold or used; (c) if at the end of the primary term or at any time thereafter one or more "
        "wells on said land or on land pooled therewith are capable of producing gas or gas-condensate in paying quantities "
        "but such well or wells are shut in before or after production therefrom, Lessee may pay as shut-in royalty %s per "
        "net mineral acre then covered hereby, and while so paid this lease shall be held as a producing lease."
        % (f(p["royalty"]), f(p["royalty"]), f(p["shutin"])),
        "4. All shut-in royalty payments under this lease shall be paid or tendered to Lessor or to Lessor's credit in the "
        "Pecos Valley State Bank at Pecos, Texas, or its successors, which bank and its successors are Lessor's agent and shall "
        "continue as the depository regardless of changes in ownership of said land or of the shut-in royalty.",
        "5. Lessee shall have the right at any time to pool or combine all or any part of said land or the oil and gas rights "
        "therein with other land, lease or leases when in Lessee's judgment it is necessary or advisable to do so in order to "
        "properly develop and operate said premises, such pooling to be of tracts contiguous to one another and to be into a "
        "unit or units not exceeding 80 acres each for oil and 640 acres each for gas, plus a tolerance of ten percent (10%). "
        "Lessee shall execute in writing and record in the conveyance records of the county in which the land is situated an "
        "instrument identifying and describing the pooled acreage. Operations on or production from any part of a pooled unit "
        "shall be treated as if such operations were on or such production were from the land described herein.",
        "6. If Lessor owns a lesser interest in the above described land than the entire and undivided fee simple estate therein, "
        "then the royalties and shut-in royalties herein provided for shall be paid Lessor only in the proportion which Lessor's "
        "interest bears to the whole and undivided fee simple estate therein. All royalty interest covered by this lease "
        "(whether or not owned by Lessor) shall be paid out of the royalty herein provided.",
        "7. Lessee shall have the right at any time to surrender this lease in whole or in part to Lessor or by recording a "
        "release in the proper county, and thereupon shall be relieved from all obligations, expressed or implied, of this "
        "agreement as to acreage so surrendered. If operations for drilling are not commenced on said land or on acreage "
        "pooled therewith on or before one year from this date, this lease shall terminate unless on or before such anniversary "
        "date Lessee shall pay or tender to Lessor a delay rental of $1.00 per acre, which shall extend the time within which "
        "drilling operations may be commenced for successive periods of twelve months each during the primary term.",
        "8. The rights of Lessor and Lessee hereunder may be assigned in whole or in part, and the provisions hereof shall extend "
        "to their heirs, executors, administrators, successors and assigns; but no change in ownership of Lessor's interest "
        "(by assignment of rentals or royalties or otherwise) shall be binding on Lessee until Lessee has been furnished with "
        "a certified copy of the recorded instrument or instruments evidencing same. No such change shall have the effect of "
        "reducing the rights of Lessee hereunder.",
        "9. Lessee shall pay for damages caused by its operations to growing crops and fences on said land. When requested by "
        "Lessor, Lessee shall bury its pipe lines below ordinary plow depth, and no well shall be drilled within two hundred "
        "feet (200') of any residence or barn now on said land without Lessor's consent.",
        "10. Lessor hereby warrants and agrees to defend the title to said land and agrees that Lessee at its option may "
        "discharge any tax, mortgage or other lien upon said land, and in the event Lessee does so, it shall be subrogated to "
        "such lien with the right to enforce same and to apply royalties and rentals accruing hereunder toward satisfying same.",
        "11. This lease is subject to the terms of the Rider and Exhibit \"A\" attached hereto, if any, and made a part hereof for "
        "all purposes. In the event of conflict between the printed portion of this lease and such Rider, the Rider shall control.",
    ]


def b_lease(I, R, rng):
    P = I.P
    base_key(I)
    form_title = "OIL, GAS AND MINERAL LEASE"
    f_in = dict(date_txt=P.get("date_markup") or d_long(I.ex), lessor=P["gor"], addr=P["addr"], lessee=P["gee"], bonus=P["bonus"], legal=P["legal"],
                acres=P["acres"], term_txt=P["term_txt"], royalty=P["royalty"], shutin=P["shutin"])
    t = [("title", form_title)]
    for para in lease_paras(f_in):
        t.append(("p", para))
    t.append(("p", "IN WITNESS WHEREOF, this instrument is executed as of the date first above written.", dict(gap=2)))
    # typed rider on the form
    rider = ["RIDER TO OIL, GAS AND MINERAL LEASE dated %s, from %s, Lessor, to %s, Lessee." % (d_long(I.ex), P["gor"], P["gee"])]
    if P.get("pugh"):
        rider.append("A. PUGH CLAUSE. %s" % P["pugh"])
    if P.get("depth"):
        rider.append("B. DEPTH LIMITATION. %s" % P["depth"])
    if P.get("warranty_rider"):
        rider.append("C. WARRANTY. %s" % P["warranty_rider"])
    if P.get("rider_extra"):
        rider.append("D. %s" % P["rider_extra"])
    t.append(("sig", signers_of(P)))
    t.append(("ack", P.get("ack_obj") or ack_dict(I, rng, persons_of(P), seal="round" if I.rec.year < 1975 else "ink")))
    if len(rider) > 1:
        t.append(("pb",))
        t.append(("typed", rider))
    if P.get("exhibit"):
        t.append(("pb",))
        t.append(("title", "EXHIBIT \"A\""))
        t.append(("p", "Attached to and made a part of that certain Oil, Gas and Mineral Lease dated %s, between %s, as Lessor, and %s, as Lessee." % (d_long(I.ex), P["gor"], P["gee"])))
        t.append(("p", "LANDS COVERED: %s" % P["exhibit"], dict(align="left")))
        if P.get("exhibit_mb"):
            t.append(("p", "FIELD NOTES: %s" % P["exhibit_mb"], dict(align="left")))
    ro = P["royalty"]
    k = I.key
    k.update({"GRANTOR": P["gor"], "GRANTEE": P["gee"], "LEGAL DESC": P["legal"], "SURFACE": "no", "MINERALS": "no (oil and gas leasehold only)",
              "ROYALTY/NPRI": "yes - lessor's royalty %s (lease royalty, not an NPRI)" % ro, "TERM": "term - %s and as long thereafter as oil or gas is produced" % P["term_txt"],
              "AFTER-ACQUIRED TITLE": "yes (Lessor's after-acquired interest language in granting clause)",
              "FRACTION CONVEYED": "royalty %s; lease of %s acres" % (ro, P["acres"]),
              "RESERVATIONS": ("A. PUGH CLAUSE. %s B. DEPTH LIMITATION. %s" % (P["pugh"], P["depth"])) if (P.get("pugh") and P.get("depth")) else "none stated",
              "WARRANTY": P.get("warranty_key", "full (Lessor warrants and agrees to defend title, para. 10)")})
    I.traps += P.get("traps", [])
    return t


def b_assignment(I, R, rng):
    P = I.P
    base_key(I)
    t = [("cap", "THE STATE OF TEXAS", "COUNTY OF %s" % COUNTY.upper(), "KNOW ALL MEN BY THESE PRESENTS:"), ("title", "ASSIGNMENT OF OIL AND GAS LEASE")]
    t.append(("p", "That %s, of %s (\"Assignor\"), for and in consideration of Ten Dollars ($10.00) and other good and valuable "
                   "consideration, the receipt and sufficiency of which are hereby acknowledged, does hereby GRANT, BARGAIN, SELL, ASSIGN, "
                   "TRANSFER and CONVEY unto %s, of %s (\"Assignee\"), %s, in and to that certain Oil, Gas and Mineral Lease "
                   "dated %s, from %s, as Lessor, to %s, as Lessee, recorded in %s, covering %s, together with all rights incident thereto "
                   "and the personal property thereon and used in connection therewith." %
                   (P["gor"], P["gor_res"], P["gee"], P["gee_res"], P["interest"], d_long(R[P["lease"]].ex), R[P["lease"]].P["gor"],
                    R[P["lease"]].P["gee"], R.text(P["lease"]), P["legal"])))
    t.append(("p", P["orri_para"]))
    t.append(("p", "This Assignment is made without warranty of title, express or implied, except that Assignor warrants that it has not "
                   "heretofore assigned, encumbered or conveyed its interest in said lease, and that said lease is in full force and effect, "
                   "by, through or under Assignor, but not otherwise."))
    t.append(("p", witness_line(I, 1)))
    t.append(("sig", signers_of(P)))
    t.append(("ack", P.get("ack_obj") or ack_dict(I, rng, [officer(P["sign"][0][0]).upper()], corp=P.get("corp"), capacity=P["sign"][0][1] if len(P["sign"][0]) > 1 else None, seal="round" if I.rec.year < 1975 else "ink")))
    if P.get("sched"):
        t.append(("pb",))
        t.append(("title", "EXHIBIT \"A\""))
        t.append(("p", P["sched"], dict(align="left")))
    k = I.key
    k.update({"GRANTOR": P["gor"], "GRANTEE": P["gee"], "LEGAL DESC": P["legal"], "SURFACE": "no", "MINERALS": "no (oil and gas leasehold only)",
              "ROYALTY/NPRI": "yes - overriding royalty reserved: %s" % P["orri_key"], "TERM": "not applicable (term of underlying lease)",
              "FRACTION CONVEYED": P["interest"], "RESERVATIONS": P["orri_para"], "WARRANTY": "special",
              })
    I.traps += P.get("traps", [])
    return t


def b_release_lease(I, R, rng):
    P = I.P
    base_key(I)
    L = R[P["lease"]]
    t = [("cap", "THE STATE OF TEXAS", "COUNTY OF %s" % COUNTY.upper(), "KNOW ALL MEN BY THESE PRESENTS:"), ("title", P.get("title", "RELEASE OF OIL AND GAS LEASE"))]
    scope = P.get("scope_txt", "all of the above described land")
    t.append(("p", "That %s, of %s (\"Lessee\"), being the present owner and holder of the Oil, Gas and Mineral Lease dated %s, from %s, as Lessor, to %s, as Lessee, "
                   "recorded in %s, covering %s, for good and valuable consideration, does hereby RELEASE, RELINQUISH and SURRENDER unto the "
                   "Lessor, or %s successors and assigns, all right, title and interest of Lessee in and to said lease insofar as it covers %s." %
                   (P["gor"], P["gor_res"], d_long(L.ex), L.P["gor"], L.P["gee"], R.text(P["lease"]), L.P["legal"], "their", scope)))
    if P.get("extra"):
        t.append(("p", P["extra"]))
    t.append(("p", P.get("reason", "Lessee states that no well was drilled upon said land and that the lease has expired by its own terms.")))
    t.append(("p", witness_line(I, 1)))
    t.append(("sig", signers_of(P)))
    t.append(("ack", P.get("ack_obj") or ack_dict(I, rng, [officer(P["sign"][0][0]).upper()], corp=P.get("corp"), capacity=P["sign"][0][1] if len(P["sign"][0]) > 1 else None, seal="round" if I.rec.year < 1975 else "ink")))
    if P.get("plat"):
        plat_exhibit(t, P)
    L.margin_notes.append((0, "%s - see %s" % (P.get("margin_word", "Released"), rel_note(I)), "hand"))
    I.key.update({"GRANTOR": P["gor"], "GRANTEE": "%s (Lessor)" % L.P["gor"], "LEGAL DESC": L.P["legal"], "FRACTION CONVEYED": "not applicable (release of lease %s)" % scope,
                  "RESERVATIONS": P.get("reservations_key", "none stated"), "WARRANTY": "not applicable"})
    I.traps += P.get("traps", [])
    return t


def b_deed_of_trust(I, R, rng):
    P = I.P
    base_key(I)
    exhibit_txt = mb_exhibit(rng, P["legal"], P["exhibit_mb"][0], P["exhibit_mb"][1]) if P.get("exhibit_mb") else None
    legal_txt = "the real property described on Exhibit \"A\" attached hereto and incorporated herein for all purposes" if exhibit_txt else P["legal"]
    t = [("cap", "THE STATE OF TEXAS", "COUNTY OF %s" % COUNTY.upper(), "KNOW ALL MEN BY THESE PRESENTS:"), ("title", "DEED OF TRUST")]
    t.append(("p", "That %s, of %s (\"Grantor\"), for the purpose of securing the indebtedness hereinafter described, and in consideration of the sum of "
                   "Ten Dollars ($10.00) to Grantor paid by %s, Trustee (\"Trustee\"), the receipt of which is hereby acknowledged, has GRANTED, SOLD and CONVEYED, "
                   "and by these presents does GRANT, SELL and CONVEY unto the said Trustee, and to %s substitutes or successors, the following described real property "
                   "in %s County, Texas: %s, together with all improvements thereon and all rights and appurtenances thereto (the \"Property\")." %
                   (P["gor"], P["gor_res"], P["trustee"], "his", COUNTY, legal_txt)))
    t.append(("p", "This conveyance is made IN TRUST to secure the full and final payment of one promissory note of even date herewith, in the principal sum of %s, "
                   "executed by Grantor, payable to the order of %s (\"Beneficiary\"), bearing interest at the rate of %s per annum, and due and payable on or before "
                   "%s." % (P["amount"], P["ben"], P["rate"], P["maturity"])))
    t.append(("p", "Grantor covenants and agrees to pay the indebtedness as it becomes due; to keep all improvements insured against loss by fire and windstorm; "
                   "to pay all taxes and assessments levied against the Property before delinquency; and to keep the Property in good repair. If Grantor fails to "
                   "do so, Beneficiary may do so at Grantor's expense and add the sums so advanced to the indebtedness. %s" % P.get("mineral_clause", "")))
    t.append(("p", "If Grantor makes default in the payment of the indebtedness or in the performance of any covenant herein, and the default continues after notice, "
                   "Beneficiary may declare the whole indebtedness due, and Trustee, on the written request of Beneficiary, shall sell the Property at public auction "
                   "at the courthouse door of %s County, Texas, between the hours of 10:00 o'clock A.M. and 4:00 o'clock P.M. on the first Tuesday of any month, after "
                   "giving notice of the time, place and terms of sale as required by law, to the highest bidder for cash, and shall execute and deliver to the purchaser "
                   "a conveyance of the Property with general warranty. If Grantor shall pay the indebtedness in full according to its terms, this conveyance shall "
                   "become null and void and of no further force and effect, and shall be released at Grantor's cost." % COUNTY))
    t.append(("p", witness_line(I, len(P["sign"]))))
    t.append(("sig", signers_of(P)))
    t.append(("ack", P.get("ack_obj") or ack_dict(I, rng, P.get("ack_persons") or persons_of(P), privy=P.get("privy"), seal="round" if I.rec.year < 1975 else "ink")))
    if exhibit_txt:
        t.append(("pb",))
        t.append(("title", "EXHIBIT \"A\""))
        t.append(("p", exhibit_txt, dict(align="left")))
    I.key.update({"GRANTOR": P["gor"], "GRANTEE": "%s, Trustee (for %s)" % (P["trustee"], P["ben"]), "LEGAL DESC": exhibit_txt or P["legal"], "SURFACE": "yes (lien)",
                  "MINERALS": "yes (lien on all of Grantor's interest)", "TERM": "term - until note paid, due %s" % P["maturity"],
                  "FRACTION CONVEYED": "all of Grantor's interest in the Property, in trust, to secure %s note" % P["amount"],
                  "WARRANTY": "full (trustee's deed on foreclosure with general warranty)"})
    I.traps += P.get("traps", [])
    return t


def b_release_dot(I, R, rng):
    P = I.P
    base_key(I)
    D = R[P["dot"]]
    t = [("cap", "THE STATE OF TEXAS", "COUNTY OF %s" % COUNTY.upper(), "KNOW ALL MEN BY THESE PRESENTS:"), ("title", P.get("title", "RELEASE OF LIEN"))]
    t.append(("p", "That %s, of %s, owner and holder of the note in the principal sum of %s, dated %s, executed by %s, and secured by the Deed of Trust of even date "
                   "therewith to %s, Trustee, recorded in %s, covering %s, acknowledges that said note has been fully paid, and does hereby RELEASE, DISCHARGE and "
                   "QUITCLAIM unto the said %s, %s heirs, successors and assigns, all liens, titles and interests held or claimed by %s under said Deed of Trust, "
                   "and the same is hereby released of record." %
                   (P["gor"], P["gor_res"], D.P["amount"], d_long(D.ex), D.P["gor"], D.P["trustee"], R.text(P["dot"]), D.P["legal"],
                    D.P["gor"], "their", "the undersigned")))
    t.append(("p", witness_line(I, 1)))
    t.append(("sig", signers_of(P)))
    t.append(("ack", P.get("ack_obj") or ack_dict(I, rng, [officer(P["sign"][0][0]).upper()], corp=P.get("corp"), capacity=P["sign"][0][1] if len(P["sign"][0]) > 1 else None, seal="round" if I.rec.year < 1975 else "ink")))
    I.key.update({"GRANTOR": P["gor"], "GRANTEE": D.P["gor"], "LEGAL DESC": D.P["legal"], "FRACTION CONVEYED": "not applicable (release of deed of trust lien)", "WARRANTY": "quitclaim"})
    D.margin_notes.append((0, P.get("margin", "Released - see " + rel_note(I)), "hand" if D.era != "B" else "pencil"))
    I.traps += P.get("traps", [])
    return t


def b_easement(I, R, rng):
    P = I.P
    base_key(I)
    t = [("cap", "THE STATE OF TEXAS", "COUNTY OF %s" % COUNTY.upper(), "KNOW ALL MEN BY THESE PRESENTS:"), ("title", P.get("title", "RIGHT-OF-WAY EASEMENT"))]
    t.append(("p", "That %s, of %s (\"Grantor\"), for and in consideration of %s to Grantor in hand paid by %s (\"Grantee\"), the receipt of which is hereby acknowledged, "
                   "has GRANTED, SOLD and CONVEYED, and by these presents does GRANT, SELL and CONVEY unto Grantee, its successors and assigns, a right-of-way and "
                   "easement %s wide, for the purpose of constructing, laying, maintaining, operating, repairing, replacing and removing %s, together with all "
                   "valves, fittings, markers and appurtenances thereto, over, across and through the following described land owned by Grantor in %s County, Texas: %s" %
                   (P["gor"], P["gor_res"], P["cons"], P["gee"], P["width"], P["purpose"], COUNTY, P["legal"])))
    t.append(("p", "The centerline of said easement is described as follows: %s" % P["route"]))
    t.append(("p", P["terms"]))
    t.append(("p", "TO HAVE AND TO HOLD the easement and rights herein granted unto Grantee, its successors and assigns, %s." % P["term_txt"]))
    if P.get("plat"):
        t.append(("p", "A sketch of the easement is shown on the plat attached hereto and made a part hereof as Exhibit \"A\"."))
    t.append(("p", witness_line(I, len(P["sign"]))))
    t.append(("sig", signers_of(P)))
    t.append(("ack", P.get("ack_obj") or ack_dict(I, rng, persons_of(P), privy=P.get("privy"), seal="round" if I.rec.year < 1975 else "ink")))
    if P.get("plat"):
        t.append(("pb",))
        t.append(("title", "EXHIBIT \"A\""))
        t.append(("plat", P["plat"]))
    I.key.update({"GRANTOR": P["gor"], "GRANTEE": P["gee"], "LEGAL DESC": P["legal"], "SURFACE": "no (easement only)", "MINERALS": "no",
                  "TERM": P["term_key"], "FRACTION CONVEYED": "right-of-way and easement %s wide" % P["width"],
                  "RESERVATIONS": P.get("reservations_key", "none stated"), "WARRANTY": P.get("warranty_key", "not applicable")})
    I.traps += P.get("traps", [])
    return t


def b_heirship(I, R, rng):
    P = I.P
    base_key(I)
    t = [("cap", "THE STATE OF TEXAS", "COUNTY OF %s" % COUNTY.upper(), ""), ("title", P.get("title", "AFFIDAVIT OF HEIRSHIP"))]
    t.append(("p", "BEFORE ME, the undersigned authority, on this day personally appeared %s and %s, who, being by me first duly sworn, upon oath state: "
                   "that they are over the age of twenty-one years, are competent to make this affidavit, and are not interested in the estate of the decedent "
                   "named below; and that they had personal knowledge of the family history of %s from before %s until %s death, and do hereby state as follows:" %
                   (P["aff1"], P["aff2"], P["dec"], P["since"], "his" if P["male"] else "her")))
    for i, para in enumerate(P["facts"], 1):
        t.append(("p", "%d. %s" % (i, para)))
    t.append(("p", "%d. The decedent owned at the time of death an interest in and to the following described real property: %s. This affidavit is made to "
                   "establish the heirship of the decedent for the purpose of showing the ownership of said property and may be relied upon by title examiners "
                   "and by all persons dealing with the same." % (len(P["facts"]) + 1, P["legal"])))
    t.append(("p", "FURTHER AFFIANTS SAYETH NOT."))
    t.append(("sig", [dict(name=P["aff1"], cap="Affiant"), dict(name=P["aff2"], cap="Affiant")]))
    a = ack_dict(I, rng, [P["aff1"].upper(), P["aff2"].upper()], seal="round" if I.rec.year < 1975 else "ink")
    a["jurat"] = True
    t.append(("jurat", a))
    I.key.update({"GRANTOR": "%s and %s (affiants); decedent %s" % (P["aff1"], P["aff2"], P["dec"]), "GRANTEE": "not applicable", "LEGAL DESC": P["legal"],
                  "FRACTION CONVEYED": "not applicable (heirship recital: %s)" % P["heirs_key"], "ACKNOWLEDGMENT": "yes (sworn jurat)"})
    I.traps += P.get("traps", [])
    return t


def b_will(I, R, rng):
    P = I.P
    base_key(I)
    t = [("title", "LAST WILL AND TESTAMENT"), ("pc", "OF %s" % P["dec"].upper(), dict(gap=8))]
    t.append(("cap", "THE STATE OF TEXAS", "COUNTY OF %s" % COUNTY.upper(), "KNOW ALL MEN BY THESE PRESENTS:"))
    t.append(("p", "I, %s, of %s County, Texas, being of sound and disposing mind and memory, and above the age of twenty-one years, do hereby make, publish and "
                   "declare this instrument to be my Last Will and Testament, hereby revoking all other wills and codicils heretofore made by me." % (P["dec"], COUNTY)))
    for i, art in enumerate(P["articles"], 1):
        t.append(("p", "ARTICLE %s. %s" % (["I", "II", "III", "IV", "V", "VI", "VII", "VIII"][i - 1], art)))
    t.append(("p", "IN WITNESS WHEREOF, I have hereunto set my hand this %s, in the presence of the undersigned witnesses, who have subscribed their names hereto at my request." % d_day(I.ex)))
    t.append(("sig", [dict(name=P["dec"], cap="Testator")]))
    t.append(("p", "The foregoing instrument was, on the date last above written, signed by the said Testator, who declared it to be %s Last Will and Testament, in our "
                   "presence, and we, at %s request and in %s presence, and in the presence of each other, have subscribed our names as attesting witnesses." %
                   ("his" if P["male"] else "her", "his" if P["male"] else "her", "his" if P["male"] else "her")))
    t.append(("sig", [dict(name=P["wit1"], cap="Witness"), dict(name=P["wit2"], cap="Witness")]))
    if P.get("self_proving"):
        a = ack_dict(I, rng, [P["dec"].upper(), P["wit1"].upper(), P["wit2"].upper()], seal="ink")
        a["jurat"] = True
        t.append(("jurat", a))
    I.key.update({"GRANTOR": P["dec"] + " (testator)", "GRANTEE": P["devisees"], "LEGAL DESC": P.get("legal_key", "none stated (general devise of all property; no tract described)"),
                  "SURFACE": "unclear (devise of all property, real and personal)", "MINERALS": "unclear (devise of all property)",
                  "FRACTION CONVEYED": P["frac_key"], "TERM": P.get("term_key", "not applicable"), "RESERVATIONS": "none stated", "WARRANTY": "not applicable",
                  "ACKNOWLEDGMENT": "yes (self-proving affidavit)" if P.get("self_proving") else "no (attested by two witnesses; no notarial acknowledgment)"})
    I.traps += P.get("traps", [])
    return t


def b_order_probate(I, R, rng):
    P = I.P
    base_key(I)
    t = [("cap", "THE STATE OF TEXAS", "COUNTY OF %s" % COUNTY.upper(), ""), ("title", "ORDER ADMITTING WILL TO PROBATE"),
         ("pc", "In the County Court of %s County, Texas -- Cause No. %s" % (COUNTY, P["cause"]), dict(gap=8))]
    t.append(("p", "On this the %s, came on to be heard the application of %s for the probate of the Last Will and Testament of %s, deceased, "
                   "dated %s, and for the issuance of Letters %s thereon. The Court, having heard the testimony of the subscribing witnesses and "
                   "the evidence, finds that the testator died on %s in %s County, Texas, having been domiciled in said county at the time of "
                   "death; that this Court has jurisdiction and venue; that four years have not elapsed since the date of death; that the will "
                   "was duly executed with the formalities and solemnities required by law, the testator being at the time of sound mind and "
                   "having attained the age of twenty-one years; and that the testator has not revoked the will." %
                   (d_day(I.ex), P["applicant"], P["dec"], d_long(R[P["will"]].ex), P["letters_kind"], d_long(P["death"]), COUNTY)))
    t.append(("p", "IT IS THEREFORE ORDERED, ADJUDGED AND DECREED that the Last Will and Testament of %s, deceased, dated %s, is hereby "
                   "ADMITTED TO PROBATE and ordered recorded in the Probate Minutes of this Court, and that %s is appointed %s thereof, to serve %s "
                   "upon taking the oath required by law%s." % (P["dec"], d_long(R[P["will"]].ex), P["applicant"], P["capacity"],
                                                              P.get("bond_txt", "without bond"), "")))
    t.append(("p", "The Will so admitted is recorded in %s." % R.text(P["will"])))
    t.append(("p", "SIGNED this the %s." % d_day(I.ex)))
    t.append(("sig", [dict(name=P["judge"], cap="Judge, County Court, %s County, Texas" % COUNTY)]))
    I.key.update({"GRANTOR": P["dec"] + " (decedent)", "GRANTEE": P["applicant"] + " (%s)" % P["capacity"], "LEGAL DESC": "none stated",
                  "FRACTION CONVEYED": "not applicable", "ACKNOWLEDGMENT": "no (court order; judge's signature)"})
    I.traps += P.get("traps", [])
    return t


def b_letters(I, R, rng):
    P = I.P
    base_key(I)
    t = [("cap", "THE STATE OF TEXAS", "COUNTY OF %s" % COUNTY.upper(), ""), ("title", "LETTERS TESTAMENTARY"), ("pc", "Cause No. %s" % P["cause"], dict(gap=8))]
    t.append(("p", "WHEREAS, the Last Will and Testament of %s, deceased, was on the %s admitted to probate by the County Court of %s County, Texas, "
                   "and %s was by said Court appointed %s thereof, and %s has duly qualified as such by taking the oath required by law%s; "
                   "NOW, THEREFORE, these Letters Testamentary are issued to %s, authorizing %s to administer the estate of said decedent, to collect and "
                   "receive the debts due the estate, and to perform all other acts as such %s as are authorized by the will and by law." %
                   (P["dec"], d_long(R[P["order"]].ex), COUNTY, P["exec"], P["capacity"], "she" if P["f"] else "he", P.get("bond", ", and having filed no bond, the will so providing"), P["exec"], "her" if P["f"] else "him", P["capacity"].lower())))
    t.append(("p", "WITNESS my hand and the seal of said Court at office in Pecos, Texas, this the %s." % d_day(I.ex)))
    t.append(("sig", [dict(name=clerk_for(I.ex.year), cap="Clerk of the County Court, %s County, Texas" % COUNTY)]))
    I.key.update({"GRANTOR": P["dec"] + " (decedent)", "GRANTEE": P["exec"] + " (%s)" % P["capacity"], "LEGAL DESC": "none stated",
                  "ACKNOWLEDGMENT": "no (letters issued under court seal)"})
    I.traps += P.get("traps", [])
    return t


def b_ratification(I, R, rng):
    P = I.P
    base_key(I)
    L = R[P["lease"]]
    t = [("cap", "THE STATE OF TEXAS", "COUNTY OF %s" % COUNTY.upper(), "KNOW ALL MEN BY THESE PRESENTS:"), ("title", "RATIFICATION OF OIL AND GAS LEASE")]
    t.append(("p", "That %s, of %s (\"Ratifying Party\"), is the owner of %s in and to the oil, gas and other minerals in and under the following land in %s County, Texas: %s. "
                   "The Ratifying Party did not execute the Oil, Gas and Mineral Lease dated %s, from %s, as Lessor, to %s, as Lessee, recorded in %s (the \"Lease\")." %
                   (P["gor"], P["gor_res"], P["interest_txt"], COUNTY, P["legal"], d_long(L.ex), L.P["gor"], L.P["gee"], R.text(P["lease"]))))
    t.append(("p", "For good and valuable consideration, the receipt and sufficiency of which are acknowledged, the Ratifying Party does hereby ADOPT, RATIFY and CONFIRM "
                   "the Lease, and does hereby GRANT, LEASE and LET unto %s, its successors and assigns, all of the Ratifying Party's interest in said land, "
                   "upon all of the terms of the Lease, as if the Ratifying Party had been an original party thereto and had executed the Lease on its date. %s" % (L.P["gee"], P.get("extra", ""))))
    t.append(("p", witness_line(I, 1)))
    t.append(("sig", signers_of(P)))
    t.append(("ack", P.get("ack_obj") or ack_dict(I, rng, [officer(P["sign"][0][0]).upper()], seal="round" if I.rec.year < 1975 else "ink")))
    I.key.update({"GRANTOR": P["gor"], "GRANTEE": L.P["gee"], "LEGAL DESC": P["legal"], "SURFACE": "no", "MINERALS": "no (ratifies lease of %s)" % P["interest_txt"],
                  "FRACTION CONVEYED": P["interest_txt"], "TERM": "same as ratified lease", "WARRANTY": "not applicable"})
    I.traps += P.get("traps", [])
    return t


def b_pooling(I, R, rng):
    P = I.P
    base_key(I)
    t = [("cap", "THE STATE OF TEXAS", "COUNTY OF %s" % COUNTY.upper(), "KNOW ALL MEN BY THESE PRESENTS:"), ("title", "DESIGNATION OF POOLED UNIT")]
    t.append(("p", "WHEREAS, %s (\"Lessee\") is the owner and holder of the oil and gas leases described below, each of which contains a provision authorizing Lessee "
                   "to pool or combine the land covered thereby, or any part thereof, with other land, lease or leases, to form a unit; and WHEREAS, Lessee desires to "
                   "exercise that right:" % P["gor"]))
    t.append(("p", "NOW, THEREFORE, Lessee does hereby designate, create and form the \"%s\" (the \"Unit\"), consisting of %s acres, more or less, comprised of the "
                   "following described lands, to-wit: %s" % (P["unit"], P["unit_acres"], P["unit_legal"])))
    for L in P["leases"]:
        t.append(("p", "Lease: %s" % L, dict(left=40, align="left")))
    t.append(("p", P["terms"]))
    t.append(("p", "The Unit shall be effective as of %s. %s" % (d_long(P["effective"]), P.get("extra", ""))))
    t.append(("p", witness_line(I, 1)))
    t.append(("sig", signers_of(P)))
    t.append(("ack", P.get("ack_obj") or ack_dict(I, rng, [officer(P["sign"][0][0]).upper()], corp=P.get("corp"), capacity=P["sign"][0][1], seal="round" if I.rec.year < 1975 else "ink")))
    if P.get("plat"):
        plat_exhibit(t, P)
    I.key.update({"GRANTOR": P["gor"], "GRANTEE": "not applicable", "LEGAL DESC": P["unit_legal"], "FRACTION CONVEYED": "not applicable (pooled unit of %s acres)" % P["unit_acres"],
                  "TERM": "not applicable (unit follows underlying leases)", "WARRANTY": "not applicable"})
    I.traps += P.get("traps", [])
    return t


def b_nonprod(I, R, rng):
    P = I.P
    base_key(I)
    T = R[P["target"]]
    t = [("cap", "THE STATE OF TEXAS", "COUNTY OF %s" % COUNTY.upper(), ""), ("title", "AFFIDAVIT OF NON-PRODUCTION")]
    t.append(("p", "BEFORE ME, the undersigned authority, on this day personally appeared %s, who, being by me first duly sworn, upon oath states: " % P["aff"]))
    for i, para in enumerate(P["facts"], 1):
        t.append(("p", "%d. %s" % (i, para)))
    t.append(("p", "FURTHER AFFIANT SAYETH NOT."))
    t.append(("sig", [dict(name=P["aff"], cap="Affiant")]))
    a = ack_dict(I, rng, [P["aff"].upper()], seal="round" if I.rec.year < 1975 else "ink")
    a["jurat"] = True
    t.append(("jurat", a))
    I.key.update({"GRANTOR": P["aff"] + " (affiant)", "GRANTEE": "not applicable", "LEGAL DESC": P["legal"], "FRACTION CONVEYED": "not applicable",
                  "ACKNOWLEDGMENT": "yes (sworn jurat)"})
    I.traps += P.get("traps", [])
    return t


def b_lis_pendens(I, R, rng):
    P = I.P
    base_key(I)
    t = [("cap", "THE STATE OF TEXAS", "COUNTY OF %s" % COUNTY.upper(), ""), ("title", "NOTICE OF LIS PENDENS")]
    t.append(("p", "NOTICE IS HEREBY GIVEN that on the %s there was filed in the %s of %s County, Texas, a suit styled \"%s\", Cause No. %s, "
                   "in which %s, Plaintiff(s), seek(s) to try title to, and to quiet title to, an undivided mineral interest in the following described land: %s. "
                   "The suit asserts that Plaintiff(s) own, and that Defendant(s) wrongfully claim, an undivided %s interest in the oil, gas and other minerals in and under said land."
                   % (d_day(P["filed"]), P["court"], COUNTY, P["case"], P["cause"], P["plaintiffs"], P["legal"], P["claim_frac"])))
    t.append(("p", "This notice is filed pursuant to the statutes of the State of Texas relating to notice of the pendency of an action affecting title to real property."))
    t.append(("p", "DATED this the %s." % d_day(I.ex)))
    t.append(("sig", signers_of(P)))
    a = ack_dict(I, rng, [officer(P["sign"][0][0]).upper()], seal="round")
    t.append(("ack", a))
    I.key.update({"GRANTOR": P["plaintiffs"] + " (plaintiffs / filing parties)", "GRANTEE": "not applicable", "LEGAL DESC": P["legal"],
                  "MINERALS": "unclear (adverse claim to undivided %s mineral interest)" % P["claim_frac"], "FRACTION CONVEYED": "not applicable (notice of pending suit)"})
    I.traps += P.get("traps", [])
    return t


def b_judgment(I, R, rng):
    P = I.P
    base_key(I)
    t = [("cap", "THE STATE OF TEXAS", "COUNTY OF %s" % COUNTY.upper(), ""), ("title", "AGREED JUDGMENT"),
         ("pc", "%s -- Cause No. %s -- %s" % (P["case"], P["cause"], P["court"]), dict(gap=8))]
    t.append(("p", "On the %s this cause came on for trial. All parties appeared and announced that they had compromised and settled their differences and agreed to "
                   "the entry of this judgment. The Court, having considered the pleadings and the agreement of the parties, is of the opinion that judgment should be rendered as follows:" % d_day(I.ex)))
    for i, par in enumerate(P["decrees"], 1):
        t.append(("p", "%d. %s" % (i, par)))
    t.append(("p", "All costs of court are taxed against the party incurring the same. All relief not expressly granted herein is denied."))
    t.append(("p", "SIGNED this the %s." % d_day(I.ex)))
    t.append(("sig", [dict(name=P["judge"], cap="Judge Presiding")]))
    t.append(("p", "APPROVED AS TO FORM AND CONTENT, AND ENTRY REQUESTED:"))
    t.append(("sig", signers_of(P)))
    I.key.update({"GRANTOR": P["gor_key"], "GRANTEE": P["gee_key"], "LEGAL DESC": P["legal"], "MINERALS": P["minerals_key"], "FRACTION CONVEYED": P["frac_key"],
                  "ACKNOWLEDGMENT": "no (court judgment)"})
    I.traps += P.get("traps", [])
    return t


def b_division_order(I, R, rng):
    P = I.P
    base_key(I)
    t = [("title", P.get("title", "DIVISION ORDER"))]
    t.append(("p", "To: %s (\"Payor\")   Date: %s" % (P["payor"], d_long(I.ex)), dict(align="left")))
    t.append(("p", "Well: %s   Lease/Unit: %s   County: %s, Texas" % (P["well"], P["unit"], COUNTY), dict(align="left")))
    t.append(("p", "Description of land: %s" % P["legal"]))
    t.append(("p", "The undersigned certify and guarantee that they are the legal owners of the interests set opposite their names in the proceeds of production from the "
                   "above well or unit, and Payor is authorized to make payment accordingly until further written notice. Title has been examined only to the extent "
                   "necessary for this order; Payor does not warrant title. Interests are stated as decimal fractions of 8/8ths of production."))
    xs = [0, 470, 720, 905]
    t.append(("table", [["OWNER", "TYPE OF INTEREST", "DECIMAL", "NOTES"]] + P["rows"], xs, dict(align=["l", "l", "r", "l"])))
    t.append(("p", "Payor may withhold payment without interest, pending resolution, of any interest as to which a title dispute or defect has been asserted. %s" % P.get("extra", "")))
    t.append(("sig", signers_of(P)))
    I.key.update({"GRANTOR": P["owners_key"], "GRANTEE": P["payor"], "LEGAL DESC": P["legal"], "FRACTION CONVEYED": "not applicable (decimal interests listed: %s)" % P["decimals_key"],
                  "ACKNOWLEDGMENT": "no (not required)"})
    I.traps += P.get("traps", [])
    return t

# ----------------------------------------------------------------------------
# The chain: ~54 instruments, patent (1889) to division/stipulation (2024)
# ----------------------------------------------------------------------------
D = dt.date


def build_chain(rng):
    reg = Registry()
    L = []

    def add(id, kind, tname, slug, ex, rec, series, style, med, **P):
        I = Inst(id, kind, tname, slug, ex, rec, series, style, med, P)
        reg.items[id] = I
        L.append(I)
        return I

    W2NPRI_NOTE = "royalty deed"
    # ---------------- Era A: longhand clerk copies -------------------------------
    add("patent1889", "patent", "Patent", "patent-state-ashcroft", D(1889, 6, 14), D(1890, 2, 3), "DR", "longhand", "book_old",
        no="412", vol="9", cert="3318", gee="Wendell P. Ashcroft", commissioner="Alvin R. Tolliver", legal=LEGAL_ALL, hour="10")
    add("wd1892", "warranty_deed", "Warranty Deed", "wd-ashcroft-pettibone", D(1892, 3, 5), D(1892, 3, 19), "DR", "longhand", "book_old",
        gor="Wendell P. Ashcroft and wife, Lucinda M. Ashcroft", gee="Hiram J. Pettibone", sign=[("Wendell P. Ashcroft",), ("Lucinda M. Ashcroft",)],
        legal=LEGAL_ALL, cons="the sum of One Thousand Six Hundred Dollars ($1,600.00)", frac="all of the land described",
        privy=("Lucinda M. Ashcroft", "Wendell P. Ashcroft"), ack_persons=["Wendell P. Ashcroft"], hour="2", plural=True,
        traps=["Married-woman acknowledgment: wife's separate (privy) examination is recited and complete. Compliant with the 1892 formalities."])
    add("dot1895", "deed_of_trust", "Deed of Trust", "dot-pettibone-toyah-bank", D(1895, 8, 10), D(1895, 8, 22), "DTR", "longhand", "book_old",
        gor="Hiram J. Pettibone and wife, Ada B. Pettibone", gor_res="of Reeves County, Texas", trustee="J. L. Dunagan", ben="the Toyah Valley State Bank",
        amount="Two Thousand Four Hundred Dollars ($2,400.00)", rate="ten per cent (10%)", maturity="August 10, 1899", legal=LEGAL_ALL,
        sign=[("Hiram J. Pettibone",), ("Ada B. Pettibone",)], privy=("Ada B. Pettibone", "Hiram J. Pettibone"), ack_persons=["Hiram J. Pettibone"], hour="9",
        traps=["Lien on entire 640 acres. Released by Release of Lien (see release 1899); the margin notation on this record confirms release."])
    add("rel1899", "release_dot", "Release of Lien", "release-lien-toyah-bank", D(1899, 9, 2), D(1899, 9, 15), "MR", "longhand", "book_old",
        dot="dot1895", gor="the Toyah Valley State Bank, by J. M. Truitt, Cashier", gor_res="at Toyah, Texas", sign=[("J. M. Truitt", "Cashier")], title="Release of Lien", hour="11")
    add("wd1901", "warranty_deed", "Warranty Deed", "wd-pettibone-ketterman", D(1901, 11, 4), D(1901, 11, 20), "DR", "longhand", "book_old",
        gor="Hiram J. Pettibone and wife, Ada B. Pettibone", gee="Thaddeus R. Ketterman", sign=[("Hiram J. Pettibone",), ("Ada B. Pettibone",)],
        legal=LEGAL_ALL, cons="the sum of Three Thousand Two Hundred Dollars ($3,200.00), of which One Thousand Four Hundred Dollars ($1,400.00) is paid in cash and the balance is evidenced by one vendor's lien note",
        frac="all of the land described", ack_persons=["Hiram J. Pettibone"], ack_defect="no_privy", plural=True, hour="3",
        extra=["It is expressly agreed and stipulated that the Vendor's Lien is retained against the above described property, premises and improvements until the above described note and all interest thereon are fully paid according to their face and tenor, effect and reading, when this deed shall become absolute."],
        traps=["Wife Ada B. Pettibone joined in the deed, but the certificate of acknowledgment names only Hiram J. Pettibone and omits her separate and privy examination; for a conveyance by a married woman at this date the certificate is defective.",
               "Vendor's lien retained to secure $1,800.00 balance note; no release of the vendor's lien is of record in this chain."])
    add("dot1912", "deed_of_trust", "Deed of Trust", "dot-ketterman-pvlt", D(1912, 4, 15), D(1912, 4, 29), "DTR", "longhand", "book_old",
        gor="Thaddeus R. Ketterman and wife, Corinne E. Ketterman", gor_res="of Reeves County, Texas", trustee="A. L. Pennington", ben="the Pecos Valley Loan and Trust Company",
        amount="Six Thousand Dollars ($6,000.00)", rate="eight per cent (8%)", maturity="April 15, 1917", legal=LEGAL_ALL,
        sign=[("Thaddeus R. Ketterman",), ("Corinne E. Ketterman",)], privy=("Corinne E. Ketterman", "Thaddeus R. Ketterman"), ack_persons=["Thaddeus R. Ketterman"], hour="1",
        traps=["Unreleased deed of trust: no release of this lien appears in the chain. Note matured April 15, 1917; examiner should require a release or analyze limitations."])
    add("esmt1918", "easement", "Right-of-Way Easement (Water Pipeline)", "esmt-ketterman-toyah-creek-water", D(1918, 7, 22), D(1918, 8, 5), "MR", "longhand", "book_old",
        gor="Thaddeus R. Ketterman and wife, Corinne E. Ketterman", gor_res="of Reeves County, Texas", gee="the Toyah Creek Water Company", cons="the sum of Two Hundred Fifty Dollars ($250.00)",
        width="twenty (20) feet", purpose="one water pipe line not exceeding eight inches in diameter", legal=LEGAL_ALL,
        route="beginning at the east line of said Section 22 at a point 1,320 feet north of the southeast corner thereof, thence westerly through said Section to the west line thereof at a point 1,300 feet north of the southwest corner.",
        terms="Grantee shall bury said pipe line not less than thirty inches below the surface, shall pay all damage to growing crops and fences, and shall restore fences cut by it. Grantor reserves the right to cross said line with roads and fences.",
        term_txt="for so long as the same is used for the purposes aforesaid", term_key="term - so long as used for the purposes granted",
        sign=[("Thaddeus R. Ketterman",), ("Corinne E. Ketterman",)], privy=("Corinne E. Ketterman", "Thaddeus R. Ketterman"), ack_persons=["Thaddeus R. Ketterman"], hour="10",
        reservations_key="Grantor reserves the right to cross said line with roads and fences.",
        traps=["Easement burdens the full 640 acres, later subdivided; term is 'so long as used' (abandonment question). Pipeline route is described only by general calls."])
    # ---------------- Era B: typed / photostat ------------------------------------
    add("wd1921", "warranty_deed", "Warranty Deed", "wd-ketterman-vandiver-min-reserved", D(1921, 5, 12), D(1921, 5, 24), "DR", "typed", "micro_neg",
        gor="Thaddeus R. Ketterman and wife, Corinne E. Ketterman", gee="Ruben D. Vandiver", sign=[("Thaddeus R. Ketterman",), ("Corinne E. Ketterman",)],
        legal=LEGAL_ALL, cons="Ten Dollars ($10.00) and other good and valuable consideration, and the further consideration of a Vendor's Lien note in the sum of Eight Thousand Dollars ($8,000.00)",
        reservation="SAVE AND EXCEPT, and there is hereby reserved unto Grantors, their heirs and assigns, an undivided one-half (1/2) interest in and to all of the oil, gas and other minerals in and under and that may be produced from the above described land, together with the right of ingress and egress at all times for the purpose of mining, drilling, exploring, operating and developing the same, and the right to lease the same.",
        minerals="yes - undivided one-half (1/2) (Grantors reserve the other undivided one-half)", frac="all of the land described, surface and an undivided one-half of the minerals",
        spacing="one_half", family="courier", plural=True, time="10:40 A.M.",
        traps=["Mineral severance: Grantors reserve an undivided 1/2 of the oil, gas and other minerals; only the surface and the other undivided 1/2 of the minerals pass to Vandiver.",
               "Vendor's Lien note of $8,000.00 recited; no release of vendor's lien of record in this chain."])
    add("mdeed1923", "mineral_deed", "Mineral Deed", "mineral-deed-ketterman-whitcomb-1-16", D(1923, 9, 18), D(1923, 10, 2), "DR", "typed", "typed_aged",
        gor="Thaddeus R. Ketterman and wife, Corinne E. Ketterman", gee="Estelle M. Whitcomb, a feme sole", sign=[("Thaddeus R. Ketterman",), ("Corinne E. Ketterman",)],
        legal=LEGAL_ALL, warranty="general",
        interest_clause="an undivided one-eighth (1/8) of the undivided one-half (1/2) mineral interest reserved by Grantors in that certain Warranty Deed to Ruben D. Vandiver dated May 12, 1921, recorded in {WD1921}, the same being an undivided " + hl("1/16", "faint") + " of all of the oil, gas and other minerals in and under, and that may be produced from, the following described land:",
        frac="an undivided one-eighth (1/8) of the undivided one-half (1/2) mineral interest reserved by Grantors ... the same being an undivided 1/16 of all of the oil, gas and other minerals",
        minerals="yes - 1/16 of the whole (1/8 of the reserved 1/2)", spacing="one_half", plural=True,
        extra=["Grantee shall have the right to receive her proportionate part of all bonuses, delay rentals and royalties under any oil and gas lease now or hereafter made upon said land. This sale is made subject to any valid existing oil and gas lease."],
        hard={"1/16": "FRACTION CONVEYED / MINERALS (the '1/16' is faint; the same interest is stated as 'one-eighth of the one-half' in the same sentence)"},
        traps=["Double fraction: 1/8 of the reserved 1/2 = 1/16 of the whole; the deed states both forms and they agree. Examiner must not compute 1/8 of the whole.",
               "Faint '1/16' in the deed text is recoverable from the double-fraction wording."])
    add("wd1925", "warranty_deed", "Warranty Deed", "wd-vandiver-brandt-e2-duhig", D(1925, 2, 9), D(1925, 2, 20), "DR", "typed", "typed_aged", faint_stamp=True, hard_exec_day=True, hard={"9th": "DATE EXECUTED (day number smudged; the same date is repeated in the acknowledgment)", "FILED FOR RECORD": "DATE RECORDED"},
        gor="Ruben D. Vandiver and wife, Pearl A. Vandiver", gee="Cecil H. Brandt", sign=[("Ruben D. Vandiver",), ("Pearl A. Vandiver",)], plural=True,
        legal=LEGAL_E2, cons="Ten Dollars ($10.00) and other good and valuable consideration",
        reservation="SAVE AND EXCEPT, and there is hereby reserved unto Grantors, their heirs and assigns, an undivided one-half (1/2) of all of the oil, gas and other minerals in and under and that may be produced from the above described land, together with the usual rights of ingress and egress.",
        minerals="yes - undivided one-half (1/2) is reserved by Grantors (see Duhig issue)", frac="all of the E/2 of Section 22, surface and minerals, less the one-half mineral reservation",
        spacing="one_half", family="amtype",
        traps=["Duhig-type overconveyance: Grantors warrant the land but reserve 1/2 of the minerals, while the 1921 deed (see Vol/Page of 1921 Warranty Deed) shows Vandiver owned only 1/2 of the minerals (the other 1/2 outstanding in Ketterman). The reservation likely fails and the grantee takes Vandiver's entire 1/2 mineral interest in the E/2 under Duhig v. Peavy-Moore.",
               "Deed does not mention the outstanding Ketterman half; the warranty clause is general."])
    add("will1927", "will", "Last Will and Testament", "will-ketterman-1927", D(1927, 3, 10), D(1928, 2, 14), "PM", "typed", "typed_aged",
        dec="Thaddeus R. Ketterman", male=True,
        articles=["I direct that all of my just debts and the expenses of my last illness and burial be paid by my Executrix as soon as practicable after my death.",
                  "I give, devise and bequeath unto my beloved wife, Corinne E. Ketterman, for and during her natural life, all of the property of which I may die seized and possessed, real, personal and mixed, wherever situated, including all interests in oil, gas and other minerals, with remainder at her death to my children, Marvin T. Ketterman, Lenora K. Pruitt and Vera K. Osgood, in equal shares, share and share alike.",
                  "I nominate and appoint my wife, Corinne E. Ketterman, Independent Executrix of this my Last Will and Testament, to serve without bond, and I direct that no action be had in the County Court in the administration of my estate other than the probate of this will and the return of an inventory and appraisement.",
                  "I authorize my Executrix, in her discretion and without order of any court, to sell, lease, exchange, mortgage or otherwise dispose of any property of my estate, including the execution of oil, gas and mineral leases and division orders, and to pay all taxes, assessments and expenses of administration; and I direct that all inheritance and estate taxes be paid out of the residue of my estate as an expense of administration.",
                  "Should any beneficiary under this will contest its validity, or any provision thereof, I give to such beneficiary the sum of One Dollar ($1.00) only, in lieu of any other provision made for such beneficiary herein."],
        wit1="Harlan D. Moore", wit2="Gertrude A. Pell", devisees="Corinne E. Ketterman (life estate); Marvin T. Ketterman, Lenora K. Pruitt and Vera K. Osgood (remainder)",
        frac_key="life estate to Corinne E. Ketterman; remainder in equal shares to Marvin T. Ketterman, Lenora K. Pruitt and Vera K. Osgood", term_key="life estate, then remainder",
        spacing="one_half", family="courier",
        traps=["Life estate in wife with remainder to three children: life tenant cannot bind remaindermen to mineral conveyances or leases beyond her estate.",
               "No self-proving affidavit; proof of the will depends on the subscribing witnesses' testimony (see order admitting will)."])
    add("order1928", "order_probate", "Order Admitting Will to Probate", "order-admit-will-ketterman", D(1928, 2, 20), D(1928, 2, 21), "PM", "typed", "typed_aged",
        will="will1927", cause="1127", dec="Thaddeus R. Ketterman", applicant="Corinne E. Ketterman", capacity="Independent Executrix", letters_kind="Testamentary",
        death=D(1928, 1, 26), judge="Hon. L. B. Strickland", spacing="one_half", family="courier")
    add("letters1928", "letters", "Letters Testamentary", "letters-testamentary-ketterman", D(1928, 2, 24), D(1928, 2, 28), "PM", "typed", "typed_aged",
        order="order1928", cause="1127", dec="Thaddeus R. Ketterman", exec="Corinne E. Ketterman", capacity="Independent Executrix", f=True, spacing="one_half", family="courier")
    add("lease1931", "lease", "Oil, Gas and Mineral Lease", "oil-gas-lease-vandiver-sandhills", D(1931, 4, 6), D(1931, 4, 17), "OGL", "form", "typed_aged", rider_extra="Lessee shall have free use of oil, gas and water from said land (except water from Lessors' domestic wells) for all operations hereunder. No well shall be drilled within three hundred (300) feet of the residence now on said land. Lessee shall pay Lessors Fifty Dollars ($50.00) for each well location, and shall pay for damages to growing crops. This lease covers only the interest owned by Lessors in said land.",
        gor="Ruben D. Vandiver and wife, Pearl A. Vandiver", gee="Sandhills Oil Company", addr="Pecos, Texas", sign=[("Ruben D. Vandiver",), ("Pearl A. Vandiver",)],
        legal=LEGAL_W2, acres="320", term_txt="five (5)", bonus="Ten and No/100 Dollars ($10.00) and other good and valuable consideration", royalty="one-eighth (1/8)", shutin="$1.00",
        exhibit=None,
        traps=["Lessors own only the surface and an undivided 1/2 of the minerals in the W/2; the lease binds only that interest and royalty is paid proportionately (para. 6). The other 1/2 is outstanding in the Ketterman estate (7/16) and Whitcomb (1/16).",
               "No Pugh clause or depth limitation; primary term 5 years (to 1936) held thereafter only by production."])
    add("lease1932", "lease", "Oil, Gas and Mineral Lease", "oil-gas-lease-whitcomb-sandhills", D(1932, 1, 19), D(1932, 2, 3), "OGL", "form", "typed_aged", rider_extra="This lease covers only the undivided mineral interest owned by Lessor under the Mineral Deed recorded in {MDEED1923}, and Lessor makes no warranty as to the remainder of the minerals in said land. Lessee shall have the right to use sufficient water, oil and gas for its operations.",
        gor="Estelle M. Whitcomb, a feme sole", gee="Sandhills Oil Company", addr="Odessa, Texas", sign=[("Estelle M. Whitcomb",)],
        legal=LEGAL_ALL, acres="640", term_txt="three (3)", bonus="Fifty and No/100 Dollars ($50.00)", royalty="one-eighth (1/8)", shutin="$1.00",
        traps=["Lessor's mineral interest is an undivided 1/16 (see Mineral Deed to Whitcomb); royalty is payable only in that proportion. Lease covers 640 acres but only her 1/16."])
    add("assign1933", "assignment", "Assignment of Oil and Gas Lease (with Overriding Royalty Reserved)", "assignment-sandhills-transpecos-orri", D(1933, 5, 2), D(1933, 5, 15), "OGL", "typed", "typed_aged",
        lease="lease1931", gor="Sandhills Oil Company, a Texas corporation", gor_res="Pecos, Texas", gee="Trans-Pecos Petroleum Corporation, a Delaware corporation", gee_res="Midland, Texas",
        interest="all of Assignor's right, title and interest as Lessee", legal=LEGAL_W2, sign=[("Sandhills Oil Company, by W. K. Haldane", "President")],
        corp=("Sandhills Oil Company", "Texas corporation"),
        orri_para="SAVE AND EXCEPT, and there is hereby RESERVED unto Assignor, its successors and assigns, an overriding royalty equal to one-thirty-second (1/32) of 8/8ths of all of the oil, gas and other minerals produced and saved from said land under said lease, free of all costs of development and operation (save taxes), the same to be delivered or paid in the same manner as the royalty to Lessors, proportionately reduced if the lease covers less than the full mineral estate in said land.",
        orri_key="overriding royalty of one-thirty-second (1/32) of 8/8ths, proportionately reduced", spacing="one_half", family="courier",
        traps=["Overriding royalty (1/32 of 8/8ths) is reserved by the assignor and, being carved from the leasehold, ends when the lease ends; it is proportionately reduced because lessors own only 1/2 of the minerals (effective 1/64 of 8/8ths).",
               "Assignment lacks warranty of the continued validity of the lease beyond 'by, through and under'."])
    add("rel1936", "release_lease", "Release of Oil and Gas Lease", "release-lease-whitcomb-sandhills", D(1936, 3, 30), D(1936, 4, 9), "OGL", "typed", "typed_aged",
        lease="lease1932", gor="Sandhills Oil Company, a Texas corporation", gor_res="Pecos, Texas", sign=[("Sandhills Oil Company, by W. K. Haldane", "President")],
        corp=("Sandhills Oil Company", "Texas corporation"), reason="Lessee states that no well was drilled upon said land, that the primary term has expired, and that the lease has terminated by its own terms; this release is made of record to remove the cloud of the lease from the title.",
        spacing="one_half", family="courier",
        traps=["Full release of the Whitcomb lease; lessee expressly states no well was drilled. Confirm no assignment of this lease is of record (none appears)."])
    add("roy1936", "royalty_deed", "Royalty Deed (Non-Participating Royalty)", "royalty-deed-vandiver-sloan-floating", D(1936, 8, 14), D(1936, 9, 1), "DR", "typed", "typed_aged",
        gor="Ruben D. Vandiver and wife, Pearl A. Vandiver", gee="Mabel R. Sloan, a feme sole", sign=[("Ruben D. Vandiver",), ("Pearl A. Vandiver",)], plural=True, legal=LEGAL_W2,
        interest_clause="an undivided one-half (1/2) of the royalty reserved or payable under any oil, gas and mineral lease now or hereafter covering the following described land, the same being a non-participating royalty interest, said royalty interest to include one-half of the royalty under that certain Oil, Gas and Mineral Lease to Sandhills Oil Company recorded in {LEASE1931}, in and to:",
        royalty_key="yes - floating NPRI: 1/2 of the royalty (one-half of whatever royalty the lease provides; 1/16 of 8/8ths under a 1/8 lease)",
        frac="an undivided one-half (1/2) of the royalty reserved or payable under any oil, gas and mineral lease",
        extra=["It is understood that Grantors reserve the exclusive right to execute oil and gas leases on said land and to receive all bonuses and delay rentals; Grantee shall own no part of the leasing rights and shall have no right to execute leases, and the royalty hereby conveyed is non-participating and free of the cost of development."],
        spacing="one_half", family="courier",
        traps=["Floating (fraction-of-royalty) NPRI: '1/2 of the royalty' follows whatever royalty the lease reserves. It is not fixed at 1/16 of production; contrast with the 1948 fixed royalty deed ('a royalty of 1/16 of 8/8ths').",
               "Grantors own only an undivided 1/2 of the W/2 minerals; royalty conveyed is a fraction of the royalty under leases covering that interest."])
    add("dot1939", "deed_of_trust", "Deed of Trust", "dot-vandiver-land-bank", D(1939, 6, 12), D(1939, 6, 26), "DTR", "typed", "typed_aged",
        gor="Ruben D. Vandiver and wife, Pearl A. Vandiver", gor_res="of Reeves County, Texas", trustee="O. L. Ratliff", ben="West Texas Land Bank Association",
        amount="Four Thousand Five Hundred Dollars ($4,500.00)", rate="five per cent (5%)", maturity="June 12, 1959", legal=LEGAL_W2,
        sign=[("Ruben D. Vandiver",), ("Pearl A. Vandiver",)], mineral_clause="Grantor also pledges to Beneficiary, as additional security, all bonuses, rentals and royalties under any oil and gas lease on the Property.",
        spacing="one_half", family="courier", traps=["Lien on W/2 and on Grantor's royalties; released by Release of Lien (1941)."])
    add("rel1941", "release_dot", "Release of Lien", "release-lien-land-bank", D(1941, 10, 8), D(1941, 10, 20), "MR", "typed", "carbon",
        dot="dot1939", gor="West Texas Land Bank Association, by T. H. Fenner, Secretary-Treasurer", gor_res="Lubbock, Texas", sign=[("West Texas Land Bank Association, by T. H. Fenner", "Secretary-Treasurer")],
        corp=("West Texas Land Bank Association", "Texas corporation"), spacing="one_half", family="courier")
    add("pool1944", "pooling", "Designation of Pooled Unit", "designation-pooled-unit-vandiver-1", D(1944, 3, 1), D(1944, 3, 17), "OGL", "typed", "typed_aged",
        gor="Trans-Pecos Petroleum Corporation, a Delaware corporation", unit="Vandiver Unit No. 1", unit_acres="640", unit_legal=LEGAL_ALL,
        leases=["{LEASE1931}"], sign=[("Trans-Pecos Petroleum Corporation, by H. L. Gaither", "Vice President")],
        corp=("Trans-Pecos Petroleum Corporation", "Delaware corporation"), effective=D(1944, 3, 1),
        terms="Said lease is hereby modified so that the Unit shall be treated as if it were one lease covering the entire unit area. Production from, or operations on, any part of the Unit shall be treated as production from or operations on each tract in the Unit, and royalties shall be allocated to each tract in the proportion that the acreage of the tract bears to the total acreage of the Unit.",
        spacing="one_half", family="courier",
        traps=["Unit includes the E/2 of Section 22 (Brandt's tract) although the only lease described covers only the W/2; the E/2 is not leased, so pooling of it is ineffective absent a lease or ratification.",
               "Allocation by surface acreage ignores that lessors own only an undivided 1/2 of the minerals in the W/2."])
    add("heir1947", "heirship", "Affidavit of Heirship", "affidavit-heirship-vandiver", D(1947, 2, 12), D(1947, 2, 20), "MR", "typed", "carbon",
        title="AFFIDAVIT OF HEIRSHIP", aff1="Walter G. Dunlap", aff2="Clyde E. Hatcher", dec="Ruben D. Vandiver", male=True, since="1915",
        facts=["The decedent, Ruben D. Vandiver, died intestate on November 3, 1946, in Reeves County, Texas. He left no will, and no administration upon his estate has been had or is necessary.",
               "The decedent was married once, to Pearl A. Vandiver, in 1912, and she survived him and is now a widow.",
               "Three children were born to the decedent and Pearl A. Vandiver: Floyd D. Vandiver, Ned R. Vandiver and Opal V. Vandiver, now Opal V. Hargis, wife of Dale Hargis.",
               "Floyd D. Vandiver died in 1941, unmarried and without issue.",
               "Ned R. Vandiver and Opal V. Hargis are living. No other person is an heir of the decedent."],
        legal=LEGAL_W2, heirs_key="Pearl A. Vandiver (widow); Ned R. Vandiver and Opal V. Hargis (children); states Floyd D. Vandiver died in 1941 unmarried and without issue",
        spacing="one_half", family="courier",
        traps=["Heirship gap: affidavit states Floyd D. Vandiver died in 1941 'unmarried and without issue'; the 1958 supplemental affidavit shows he left two children. Later conveyances by Pearl, Ned and Opal omit those heirs.",
               "Shares of the surviving spouse and children are not stated; affidavit identifies heirs only."])
    add("roy1948", "royalty_deed", "Royalty Deed (Non-Participating Royalty)", "royalty-deed-vandiver-heirs-alcorn-fixed", D(1948, 3, 9), D(1948, 3, 22), "DR", "typed", "typed_aged",
        gor="Pearl A. Vandiver, a widow, Ned R. Vandiver and wife, Imogene Vandiver, and Opal V. Hargis and husband, Dale Hargis", gee="Bryce L. Alcorn",
        sign=[("Pearl A. Vandiver",), ("Ned R. Vandiver",), ("Imogene Vandiver",), ("Opal V. Hargis",), ("Dale Hargis",)], plural=True, legal=LEGAL_W2,
        interest_clause="a royalty of " + hl("1/16", "smudge") + " of 8/8ths (one-sixteenth of eight-eighths) of all of the oil, gas and other minerals produced and saved from, and that may hereafter be produced and saved from, the following described land, the same being a non-participating royalty interest, in and to:",
        royalty_key="yes - fixed NPRI: royalty of 1/16 of 8/8ths of production",
        frac="a royalty of 1/16 of 8/8ths (one-sixteenth of eight-eighths) of all of the oil, gas and other minerals produced and saved",
        hard={"1/16": "FRACTION CONVEYED / ROYALTY (smudged '1/16'; the words 'one-sixteenth of eight-eighths' follow in the same sentence)"},
        extra=["Grantors reserve all leasing rights and all bonuses and delay rentals. This royalty is free of cost of production and shall not be reduced by the proportionate-reduction clause of any lease except by reason of a lesser mineral interest in the lessors."],
        spacing="one_half", family="courier",
        traps=["Fixed NPRI: 'a royalty of 1/16 of 8/8ths' is a fraction of production, not of the lease royalty (compare floating 1/2-of-royalty in the 1936 Sloan deed). Combined with Sloan's 1/2 of the royalty it may over-convey the royalty from a 1/2 mineral interest.",
               "Grantors are only the three persons named in the 1947 heirship affidavit; Floyd D. Vandiver's children (shown in the 1958 supplemental affidavit) did not join, so their undivided share of the minerals is not conveyed.",
               "Smudged '1/16' is confirmed by the words that follow it."])
    add("sdeed1949", "surface_deed", "Warranty Deed (Surface Only)", "wd-brandt-fenske-surface-only", D(1949, 4, 4), D(1949, 4, 18), "DR", "typed", "typed_aged", faint_stamp=True,
        gor="Cecil H. Brandt and wife, Ina M. Brandt", gee="Roy E. Fenske and wife, Ardith Fenske", sign=[("Cecil H. Brandt",), ("Ina M. Brandt",)], plural=True,
        legal="the East Half (E/2) of Section 23, Block 53, Township 7, Texas and Pacific Railway Company Survey, Reeves County, Texas, Abstract No. 4173, containing 320 acres, more or less",
        interest_clause="all of the surface estate only of the following described land situated in %s County, Texas, to-wit:" % COUNTY,
        reservation="EXCEPTING AND RESERVING unto Grantors, their heirs and assigns, all of the oil, gas and other minerals in and under and that may be produced from the above described land, together with the usual rights of ingress and egress for the purpose of exploring for, developing, producing and marketing the same.",
        frac="the surface estate only; all minerals excepted and reserved", spacing="one_half", family="courier",
        traps=["Scrivener's error: legal description reads 'Section 23, Abstract No. 4173', but the grantors own the E/2 of Section 22 (Abstract No. 4172); corrected by the 1950 Correction Deed.",
               "Surface-only conveyance; all minerals reserved to Brandt (who holds Vandiver's former 1/2 mineral interest in the E/2 under the 1925 deed)."])
    add("corr1950", "correction_deed", "Correction Warranty Deed (Surface Only)", "correction-deed-brandt-fenske", D(1950, 1, 30), D(1950, 2, 10), "DR", "typed", "typed_aged",
        orig="sdeed1949", wrong="Section 23, Block 53, Township 7, Abstract No. 4173", right="Section 22, Block 53, Township 7, Abstract No. 4172",
        gor="Cecil H. Brandt and wife, Ina M. Brandt", gee="Roy E. Fenske and wife, Ardith Fenske", sign=[("Cecil H. Brandt",)], plural=True, legal=LEGAL_E2,
        interest_clause="all of the surface estate only of the following described land situated in %s County, Texas, to-wit:" % COUNTY,
        reservation="EXCEPTING AND RESERVING unto Grantors, their heirs and assigns, all of the oil, gas and other minerals in and under and that may be produced from the above described land, together with the usual rights of ingress and egress for the purpose of exploring for, developing, producing and marketing the same.",
        frac="the surface estate only; all minerals excepted and reserved", spacing="one_half", family="courier",
        traps=["Corrects the 1949 scrivener's error (Section 23 -> Section 22). Only Cecil H. Brandt signs; the wife, named as a grantor, does not sign this correction deed and the acknowledgment names only him."])
    add("divord1952", "division_order", "Division Order", "division-order-vandiver-unit-1", D(1952, 7, 1), D(1952, 7, 15), "MR", "typed", "typed_aged",
        payor="Trans-Pecos Petroleum Corporation", well="Vandiver Unit No. 1", unit="Vandiver Unit No. 1", legal=LEGAL_ALL,
        rows=[["Bryce L. Alcorn", "NPRI (fixed 1/16 of 8/8)", ".06250000", ""], ["Mabel R. Sloan", "NPRI (1/2 of royalty)", ".03125000", ""],
              ["Pearl A. Vandiver", "Royalty", ".01562500", "W/2"], ["Ned R. Vandiver", "Royalty", ".01562500", "W/2"], ["Opal V. Hargis", "Royalty", ".01562500", "W/2"],
              ["Sandhills Oil Company", "ORRI (1/32 of 8/8)", ".03125000", "assigned lease"]],
        owners_key="Bryce L. Alcorn; Mabel R. Sloan; Pearl A. Vandiver; Ned R. Vandiver; Opal V. Hargis; Sandhills Oil Company",
        decimals_key="Alcorn .0625; Sloan .03125; Vandiver heirs .015625 each; Sandhills ORRI .03125",
        sign=[("Bryce L. Alcorn",), ("Mabel R. Sloan",), ("Pearl A. Vandiver",), ("Ned R. Vandiver",), ("Opal V. Hargis",)], spacing="single", family="courier",
        traps=["Royalty decimals (.0625 + .03125 + 3 x .015625 = .140625) exceed the 1/8 (.125) royalty of the lease; unreconciled over-allocation, and ORRI shown to Sandhills though the 1933 assignment reserved it to Sandhills as assignor.",
               "No acknowledgment is required for a division order; payor warrants no title."])
    add("qc1953", "quitclaim", "Quitclaim Deed", "quitclaim-pruitt-ketterman", D(1953, 5, 19), D(1953, 6, 1), "DR", "typed", "carbon",
        gor="Lenora K. Pruitt and husband, Dale E. Pruitt", gee="Marvin T. Ketterman", sign=[("Lenora K. Pruitt",), ("Dale E. Pruitt",)], plural=True, legal=LEGAL_ALL,
        interest_clause="all of Grantors' right, title and interest, whatever it may be, in and to all of the oil, gas and other minerals in and under, and any other interest of every kind owned by Grantors in, the following described real property situated in %s County, Texas:" % COUNTY,
        frac="all of Grantors' right, title and interest, whatever it may be (no fraction stated)", spacing="one_half", family="courier",
        traps=["Quitclaim of an unspecified interest (no fraction): conveys only what Lenora then owned (1/3 of 7/16 of the minerals by remainder, vested on Corinne's death in 1951). No warranty and no after-acquired title.",
               "Lenora later joins in a 1960 lease as if she still owned an interest; the quitclaim shows she had conveyed it."])
    add("swd1956", "special_warranty", "Special Warranty Deed", "special-warranty-fenske-triple-cross", D(1956, 9, 10), D(1956, 9, 24), "DR", "typed", "typed_aged",
        gor="Roy E. Fenske and wife, Ardith Fenske", gee="Triple Cross Ranch Company, a Texas corporation", sign=[("Roy E. Fenske",), ("Ardith Fenske",)], plural=True,
        legal=LEGAL_E2, subj_to="This conveyance is made and accepted subject to all valid and subsisting easements, restrictions, reservations and mineral conveyances of record, including the reservation of oil, gas and other minerals in the Correction Warranty Deed from Cecil H. Brandt and wife, Ina M. Brandt, to Grantors recorded in {CORR1950}.",
        frac="the East Half (E/2) of Section 22, subject to prior mineral reservations of record", minerals="unclear - conveys whatever Grantors own; Grantors own only the surface (minerals reserved by Brandt)",
        spacing="one_half", family="amtype", ack_corp=None,
        traps=["Grantor owns only the surface (Brandt reserved all minerals); deed conveys 'the East Half' but is made subject to the prior mineral reservation of record. Special warranty only."])
    add("term1957", "royalty_deed", "Term Royalty Deed", "term-royalty-deed-ketterman-osgood-glover", D(1957, 3, 15), D(1957, 3, 28), "DR", "typed", "typed_aged",
        title="TERM ROYALTY DEED", gor="Marvin T. Ketterman, a single man, and Vera K. Osgood, joined by her husband, Lloyd J. Osgood", gee="Harlan P. Glover",
        sign=[("Marvin T. Ketterman",), ("Vera K. Osgood",), ("Lloyd J. Osgood",)], plural=True, legal=LEGAL_ALL,
        interest_clause="a non-participating royalty equal to one-sixty-fourth (1/64) of 8/8ths of all of the oil, gas and other minerals produced and saved from the following described land, for a term of " + hl("ten (10)", "smudge") + " years from the date hereof and as long thereafter as oil, gas or other minerals are produced from said land or from land pooled therewith, in and to:",
        royalty_key="yes - term NPRI: royalty equal to 1/64 of 8/8ths",
        term="term - ten (10) years from March 15, 1957 and as long thereafter as oil, gas or other minerals are produced",
        frac="a non-participating royalty equal to one-sixty-fourth (1/64) of 8/8ths of all of the oil, gas and other minerals produced and saved",
        hard={"ten (10)": "TERM (smudged 'ten (10)' years; number written both in words and figures)"},
        spacing="one_half", family="courier",
        traps=["Term royalty: expires ten years from March 15, 1957 (March 15, 1967) unless there is production; see the 1969 Affidavit of Non-Production (which is contradicted by later documents).",
               "Lenora K. Pruitt does not join (she had quitclaimed to Marvin in 1953). Whether Marvin held her interest on this date is a question for the chain.",
               "Smudged 'ten (10)' is recoverable from word and numeral."])
    add("suppheir1958", "heirship", "Supplemental Affidavit of Heirship", "supplemental-affidavit-heirship-vandiver", D(1958, 6, 9), D(1958, 6, 18), "MR", "typed", "typed_aged",
        title="SUPPLEMENTAL AFFIDAVIT OF HEIRSHIP", aff1="Clyde E. Hatcher", aff2="Orville M. Pate", dec="Ruben D. Vandiver", male=True, since="1915",
        facts=["This affidavit supplements and corrects that certain Affidavit of Heirship concerning the estate of Ruben D. Vandiver, deceased, recorded in {HEIR1947}.",
               "Floyd D. Vandiver, a son of the decedent, died in 1941. In the prior affidavit it was erroneously stated that he died unmarried and without issue.",
               "Floyd D. Vandiver was in fact married to Alma R. Vandiver, who died in 1950, and there were born of that marriage two children, Dorothy F. Vandiver, now Dorothy F. Keane, wife of Joel Keane, and Glenn R. Vandiver, both of whom are living.",
               "The heirs of Ruben D. Vandiver, deceased, are therefore: Pearl A. Vandiver, his widow; Ned R. Vandiver and Opal V. Hargis, his children; and Dorothy F. Keane and Glenn R. Vandiver, children of his predeceased son Floyd D. Vandiver."],
        legal=LEGAL_W2, heirs_key="Pearl A. Vandiver (widow); Ned R. Vandiver and Opal V. Hargis (children); Dorothy F. Keane and Glenn R. Vandiver (grandchildren through predeceased son Floyd D. Vandiver)",
        spacing="one_half", family="courier",
        traps=["Cures the heirship gap in the 1947 affidavit (Floyd D. Vandiver left two children) but is itself a hearsay affidavit; the 1948 royalty deed to Alcorn lacks the grandchildren's joinder.",
               "Shares of the heirs are still not stated."])
    add("lease1960", "lease", "Oil, Gas and Mineral Lease", "oil-gas-lease-ketterman-cimarron-pugh", D(1960, 2, 15), D(1960, 3, 1), "OGL", "form", "copy", date_markup="February <h:blot>15</h>, 1960", hard={"15": "DATE EXECUTED (ink blot over the day; the same date is repeated in the acknowledgment)"},
        gor="Marvin T. Ketterman, a single man, Lenora K. Pruitt and husband, Dale E. Pruitt, and Vera K. Osgood and husband, Lloyd J. Osgood", gee="Cimarron Exploration Company", addr="c/o Box 1137, Pecos, Texas",
        sign=[("Marvin T. Ketterman",), ("Lenora K. Pruitt",), ("Dale E. Pruitt",), ("Vera K. Osgood",), ("Lloyd J. Osgood",)],
        legal=LEGAL_ALL, acres="640", term_txt="three (3)", bonus="Twenty-five and No/100 Dollars ($25.00) per net mineral acre", royalty="three-sixteenths (3/16)", shutin="$1.00",
        pugh="Notwithstanding anything contained herein to the contrary, at the expiration of the primary term or any extension thereof, this lease shall terminate as to all lands and depths not then included within a producing pooled unit or a proration unit assigned to a producing well, save and except that if Lessee is then engaged in drilling operations, this lease shall continue as to the acreage so assigned for so long as such operations are continued with no cessation of more than ninety (90) consecutive days.",
        depth="Upon the expiration of the primary term, this lease shall terminate as to all depths below one hundred feet (100') below the stratigraphic equivalent of the deepest depth drilled in any well drilled on the leased premises or on lands pooled therewith, and Lessors shall retain all rights below such depth.",
        exhibit="Section 22, Block 53, Township 7, Texas and Pacific Railway Company Survey, Reeves County, Texas, Abstract No. 4172, containing 640 acres, more or less. Lessors own an undivided seven-sixteenths (7/16) of the oil, gas and other minerals in and under said Section.",
        reservations_key="Pugh clause (rider A): lease terminates as to lands and depths not in a producing unit at end of primary term; Depth limitation (rider B): terminates below 100 feet below the stratigraphic equivalent of the deepest depth drilled",
        traps=["Pugh clause (Rider A) and depth limitation (Rider B) in the typed rider override the printed lease; the lease holds only the lands and depths in production after the primary term.",
               "Lenora K. Pruitt signs as lessor although she quitclaimed her interest to Marvin T. Ketterman in 1953; lessors' stated 7/16 is the total of the Ketterman line, but Vandiver's, Whitcomb's and Brandt's mineral interests are not covered.",
               "Royalty is 3/16; any floating NPRI under this lease computes at 3/16, not 1/8."])
    add("lis1964", "lis_pendens", "Notice of Lis Pendens", "lis-pendens-keane-v-alcorn", D(1964, 8, 11), D(1964, 8, 13), "MR", "typed", "typed_aged",
        court="143rd Judicial District Court", case="Dorothy F. Keane, et al. v. Bryce L. Alcorn, et al.", cause="9,614", plaintiffs="Dorothy F. Keane and Glenn R. Vandiver", legal=LEGAL_W2,
        claim_frac="one-sixth (1/6)", filed=D(1964, 8, 10), sign=[("Hollis B. Rutledge", "Attorney for Plaintiffs")], spacing="one_half", family="courier",
        traps=["Notice of suit to try title to an undivided 1/6 mineral interest in the W/2; a later judgment (1965) resolves it. Title examiner must not treat the W/2 minerals as free of this claim between filing and judgment."])
    add("judg1965", "judgment", "Agreed Judgment", "agreed-judgment-keane-v-alcorn", D(1965, 4, 27), D(1965, 5, 5), "CM", "typed", "typed_aged",
        court="143rd Judicial District Court, Reeves County, Texas", case="Dorothy F. Keane, et al. v. Bryce L. Alcorn, et al.", cause="9,614", judge="Hon. Everett L. Ramsey",
        legal=LEGAL_W2, gor_key="Bryce L. Alcorn; Ned R. Vandiver; Opal V. Hargis (defendants)", gee_key="Dorothy F. Keane and Glenn R. Vandiver (plaintiffs)", minerals_key="yes - undivided 1/6 of the minerals in the W/2 decreed to plaintiffs",
        frac_key="an undivided one-sixth (1/6) of the oil, gas and other minerals in and under the W/2",
        decrees=["Plaintiffs, Dorothy F. Keane and Glenn R. Vandiver, are the owners of, and are awarded title to, an undivided one-sixth (1/6) interest in the oil, gas and other minerals in and under " + LEGAL_W2 + ", as heirs of Floyd D. Vandiver, deceased.",
                 "The royalty deed from Pearl A. Vandiver, et al., to Bryce L. Alcorn, recorded in {ROY1948}, is valid and effective as to the interests of the grantors named therein, and does not bind or convey the interest of Plaintiffs.",
                 "Defendants disclaim any interest in the one-sixth (1/6) mineral interest awarded to Plaintiffs."],
        sign=[("Hollis B. Rutledge", "Attorney for Plaintiffs"), ("Dale M. Cobb", "Attorney for Defendants")], spacing="one_half", family="courier",
        traps=["Judgment decrees plaintiffs an undivided 1/6 of the minerals in the W/2 and limits the Alcorn fixed royalty to the interests of its signing grantors. Alcorn royalty must be recomputed.",
               "No acknowledgment is required for a court judgment; the judgment is signed by the judge and approved by counsel."])
    add("nonprod1969", "nonprod", "Affidavit of Non-Production", "affidavit-non-production-term-royalty", D(1969, 1, 8), D(1969, 1, 16), "MR", "typed", "carbon",
        target="term1957", aff="Garland T. Pruett", legal=LEGAL_ALL,
        facts=["I am a landman residing in Midland, Texas, over twenty-one years of age, and I have personal knowledge of the facts stated herein.",
               "That certain Term Royalty Deed from Marvin T. Ketterman, et al., to Harlan P. Glover dated March 15, 1957, is recorded in {TERM1957}, and covers " + LEGAL_ALL + ".",
               "The ten-year primary term of said royalty expired on March 15, 1967.",
               "I have examined the records of the Railroad Commission of Texas and have inspected the premises, and no oil, gas or other minerals have been produced from said land, or from land pooled therewith, since January 1, 1956. The Vandiver Unit No. 1 well was plugged and abandoned in 1955.",
               "Upon information and belief, the said Term Royalty Deed has terminated by its own terms."],
        spacing="one_half", family="courier",
        traps=["Affidavit of non-production asserts termination of the 1957 term royalty (term ended March 15, 1967). It is conclusory and by a landman; later documents (1982 assignment) recite continuous production since 1962 from the Ketterman No. 1 well, which would extend the term royalty."])
    add("part1967", "partition", "Partition Deed", "partition-deed-vandiver-heirs", D(1967, 8, 14), D(1967, 8, 29), "DR", "typed", "typed_aged", plat=dict(title="PLAT OF PARTITION - W/2 SECTION 22, BLOCK 53, T-7, T&P RY. CO. SURVEY", labels=[("N/2 OF W/2 - 160 AC. (NED R. VANDIVER)", (0.5, 0.25)), ("S/2 OF W/2 - 160 AC. (HARGIS, KEANE, G. VANDIVER)", (0.5, 0.75)), ("W/2 SEC. 22", (0.5, 0.06))], scale="NOT TO SCALE"),
        gor="Ned R. Vandiver and wife, Imogene Vandiver, Opal V. Hargis and husband, Dale Hargis, Dorothy F. Keane and husband, Joel Keane, and Glenn R. Vandiver, a single man", gee="the same parties, each as to the tract set out to him or her",
        legal=LEGAL_W2, sign=[("Ned R. Vandiver",), ("Imogene Vandiver",), ("Opal V. Hargis",), ("Dale Hargis",), ("Dorothy F. Keane",), ("Joel Keane",), ("Glenn R. Vandiver",)],
        tract_a=LEGAL_N2W2, owner_a="Ned R. Vandiver", tract_b=LEGAL_S2W2, owner_b="Opal V. Hargis, Dorothy F. Keane and Glenn R. Vandiver, as tenants in common",
        spacing="one_half", family="courier",
        traps=["Partition in kind of surface and minerals of the W/2, but Pearl A. Vandiver (an heir under the 1947 affidavit and a grantor of the 1948 royalty) is not a party and no deed or probate from her appears in the chain.",
               "Royalty burdens (Sloan floating NPRI, Alcorn fixed NPRI, Glover term royalty) remain on both tracts; the partition does not discharge them. Surface and minerals both partitioned, but the other 1/2 mineral interest in the W/2 (Ketterman line) is outstanding."])
    add("dot1970", "deed_of_trust", "Deed of Trust", "dot-triple-cross-first-pecos-national", D(1970, 6, 2), D(1970, 6, 15), "DTR", "typed", "copy",
        gor="Triple Cross Ranch Company, a Texas corporation", gor_res="of Reeves County, Texas", trustee="D. W. Hale", ben="First Pecos National Bank",
        amount="Eighty-Five Thousand Dollars ($85,000.00)", rate="eight per cent (8%)", maturity="June 1, 1990", legal=LEGAL_E2,
        sign=[("Triple Cross Ranch Company, by R. L. Medley", "President")], ack_corp=("Triple Cross Ranch Company", "Texas corporation"),
        mineral_clause="Grantor's interest in the Property includes only the surface estate; no minerals are pledged.", spacing="one_half", family="courier",
        traps=["Unreleased deed of trust: matured June 1, 1990; no release of record. Property was conveyed in 1991 by Triple Cross Ranch Company with no mention of this lien."])
    add("rat1974", "ratification", "Ratification of Oil and Gas Lease", "ratification-lease-glover", D(1974, 11, 6), D(1974, 11, 18), "OGL", "typed", "typed_aged",
        lease="lease1960", gor="Harlan P. Glover, a married man dealing in his separate property", gor_res="of Pecos, Texas", legal=LEGAL_ALL,
        interest_txt="a term non-participating royalty equal to one-sixty-fourth (1/64) of 8/8ths", sign=[("Harlan P. Glover",)],
        extra="The Ratifying Party subordinates his royalty to the Lease and agrees that it shall be paid only out of the royalty provided in the Lease.", spacing="one_half", family="courier",
        traps=["Ratification of the 1960 lease by the term-royalty owner after the stated term ended (1967); it cannot revive an expired term royalty absent production, and it subordinates his royalty to the lease."])
    add("esmt1977", "easement", "Pipeline Right-of-Way Easement", "pipeline-easement-triple-cross-rio-pecos-plat", D(1977, 3, 21), D(1977, 4, 4), "MR", "typed", "copy",
        gor="Triple Cross Ranch Company, a Texas corporation", gor_res="of Reeves County, Texas", gee="Rio Pecos Gathering Company, a Texas corporation", cons="Four Thousand Dollars ($4,000.00)",
        width="thirty (30) feet", purpose="one natural gas gathering pipeline not exceeding ten and three-fourths inches (10-3/4\") in diameter", legal=LEGAL_E2,
        route="beginning at a point on the west line of said E/2, 1,980 feet south of the northwest corner of Section 22; thence N 88\u00b020' E, 1,100 feet; thence S 61\u00b005' E, 1,640 feet to a point on the east line of said Section, 2,310 feet south of the northeast corner of Section 22.",
        terms="Grantee shall bury the pipeline not less than thirty-six inches (36\") below the surface, shall pay for all damage to crops, fences and improvements, and shall maintain suitable markers at fence and road crossings. Grantor reserves the right to use the surface of the easement strip for any purpose that does not interfere with the pipeline.",
        term_txt="so long as the same is used for the purposes herein granted", term_key="term - so long as used for the purposes granted",
        sign=[("Triple Cross Ranch Company, by R. L. Medley", "President")], ack_corp=("Triple Cross Ranch Company", "Texas corporation"),
        plat=dict(title="PLAT OF 30' PIPELINE EASEMENT - E/2 SECTION 22, BLOCK 53, T-7, T&P RY. CO. SURVEY", route=[(0.0, 0.31), (0.55, 0.28), (1.0, 0.52)], route_label="30' P/L ESMT",
                  labels=[("SEC. 22", (0.30, 0.72)), ("E/2 - 320 AC.", (0.72, 0.78)), ("TRIPLE CROSS RANCH CO.", (0.50, 0.12))], scale="SCALE: 1\" = 2000'  (NOT A SURVEY)"),
        plat_flag=True, reservations_key="Grantor reserves the right to use the surface of the easement strip for any purpose that does not interfere with the pipeline.",
        spacing="one_half", family="courier",
        traps=["Easement granted by the surface owner (surface-only title); the mineral owners hold the dominant estate. Route is shown on an attached sketch plat (not a survey)."])
    # ---------------- Era C: word processed ---------------------------------------
    add("assign1982", "assignment", "Assignment of Oil and Gas Lease (with Overriding Royalty Reserved)", "assignment-cimarron-delaware-basin-orri", D(1982, 12, 14), D(1982, 12, 28), "OPR", "wp", "copy", sched="SCHEDULE OF WELLS AND PERSONAL PROPERTY. The Ketterman No. 1 well, located in the SW/4 of Section 22, Block 53, Township 7, Texas and Pacific Railway Company Survey, Reeves County, Texas (API No. 42-389-00000, a fictional number), together with the wellhead equipment, tubing, rods, pumping unit, two 400-barrel stock tanks, one separator and the flow lines located on the lease, and all oil in storage above the pipeline connection.",
        lease="lease1960", gor="Cimarron Exploration Company, a Texas corporation", gor_res="Pecos, Texas", gee="Delaware Basin Operating, Inc., a Texas corporation", gee_res="Midland, Texas",
        interest="all of Assignor's right, title and interest as Lessee, including the Ketterman No. 1 well, which has produced continuously since 1962",
        legal=LEGAL_ALL, sign=[("Cimarron Exploration Company, by Dwight A. Cheney", "Vice President")], corp=("Cimarron Exploration Company", "Texas corporation"),
        orri_para="Assignor RESERVES unto itself, its successors and assigns, an overriding royalty of three percent (3%) of 8/8ths of all oil, gas and other minerals produced and saved under said lease, proportionately reduced to the interest actually owned by Lessors, and payable free of the costs of production but bearing its proportionate share of production, severance and ad valorem taxes.",
        orri_key="overriding royalty of three percent (3%) of 8/8ths, proportionately reduced",
        traps=["ORRI of 3% of 8/8ths reserved, proportionately reduced. Assignment recites continuous production since 1962 from the Ketterman No. 1 well, contradicting the 1969 Affidavit of Non-Production (term royalty may have continued).",
               "Assignor reserves the ORRI only as to the lease; any release of the lease terminates it."])
    add("wd1991", "warranty_deed", "Warranty Deed", "wd-triple-cross-hagen-surface", D(1991, 5, 20), D(1991, 6, 3), "OPR", "wp", "copy", exhibit_mb=("the Northeast corner", 320),
        gor="Triple Cross Ranch Company, a Texas corporation", gee="Hagen Land and Cattle Company, a Texas general partnership", sign=[("Triple Cross Ranch Company, by R. L. Medley", "President")],
        legal=LEGAL_E2, cons="Ten Dollars ($10.00) and other good and valuable consideration",
        reservation="SAVE AND EXCEPT all oil, gas and other minerals in and under and that may be produced from the above described land, which are not owned by Grantor and are subject to prior reservations and conveyances of record.",
        minerals="no - save and except all oil, gas and other minerals", frac="the East Half (E/2) of Section 22, surface only (minerals excepted)", after_acq=True, ack_corp=("Triple Cross Ranch Company", "Texas corporation"),
        traps=["Deed of trust to First Pecos National Bank (1970, matured 1990) remains unreleased of record and burdens this tract.",
               "'Save and except all oil, gas and other minerals' is general: it excepts, and does not reserve to Grantor, minerals owned by others; Grantor owned only the surface.",
               "After-acquired title clause present."])
    add("mdeed1994", "mineral_deed", "Mineral Deed", "mineral-deed-ketterman-pioneer-1-2-of-1-3", D(1994, 8, 23), D(1994, 9, 2), "OPR", "wp", "copy",
        gor="Marvin T. Ketterman, a single man", gee="Pioneer Mineral Holdings, Inc., a Texas corporation", sign=[("Marvin T. Ketterman",)], legal=LEGAL_ALL, warranty="special",
        interest_clause="an undivided one-half (1/2) of Grantor's undivided one-third (" + hl("1/3", "faint") + ") interest in the oil, gas and other minerals in and under, and that may be produced from, the following described land:",
        frac="an undivided one-half (1/2) of Grantor's undivided one-third (1/3) interest in the oil, gas and other minerals",
        hard={"1/3": "FRACTION CONVEYED (the numeral in the parenthesis is faint; 'one-third' is written in words just before it)"},
        minerals="yes - an undivided 1/2 of Grantor's undivided 1/3 mineral interest (see issues)",
        extra=["This sale is made subject to all valid and subsisting oil and gas leases of record, and Grantee shall be entitled to its proportionate share of all bonuses, rentals and royalties from and after the date hereof."],
        traps=["Double fraction: 'one-half of Grantor's one-third' is not a fraction of the whole. Grantor's interest = 1/3 of 7/16 (will remainder) + 1953 quitclaim from Lenora; the deed does not say whether the '1/3' includes Lenora's interest. Resolved decimal depends on that reading (7/96 vs 7/48 of the whole).",
               "Subject to existing lease (1960); conveys leasing rights and royalty proportionately."])
    add("will2003", "will", "Last Will and Testament", "will-marvin-ketterman-2003", D(1998, 11, 5), D(2003, 5, 28), "DOC", "wp", "modern_gray", cover=True,
        dec="Marvin T. Ketterman", male=True,
        articles=["I direct that my just debts and funeral expenses be paid by my Independent Executor as soon as practicable after my death.",
                  "I give, devise and bequeath all of my mineral interests, royalty interests and overriding royalty interests, of every kind and wherever located, including all interests that I acquired by quitclaim deed from my sister, Lenora K. Pruitt, in Reeves County, Texas, in equal shares to my niece, Donna Ketterman Reyes, and my nephew, Calvin R. Osgood.",
                  "I give, devise and bequeath all of the rest and residue of my property to my niece, Donna Ketterman Reyes.",
                  "I appoint my niece, Donna Ketterman Reyes, as Independent Executor of this my Last Will and Testament, to serve without bond, and request that no action other than probate of this will and the filing of an inventory be had in any court.",
                  "My Independent Executor shall have full power and authority, without order of any court, to sell, lease, convey, exchange and encumber any real or personal property of my estate, including the power to execute oil, gas and mineral leases, to pool and unitize, and to execute division orders, transfer orders and ratifications, upon such terms as my Independent Executor considers advisable.",
                  "If any beneficiary named herein does not survive me by thirty (30) days, the share of such beneficiary shall pass to the other beneficiary named in the same Article, and if neither survives me, to the descendants of my sister, Vera K. Osgood, per stirpes.",
                  "All inheritance, estate and other death taxes payable by reason of my death shall be paid out of the residue of my estate without apportionment."],
        wit1="Gail R. Whitaker", wit2="Roberto M. Salas", devisees="Donna Ketterman Reyes and Calvin R. Osgood (equal shares of all mineral and royalty interests); Donna Ketterman Reyes (residue)",
        frac_key="all mineral, royalty and overriding royalty interests in equal shares to Donna Ketterman Reyes and Calvin R. Osgood", self_proving=True,
        traps=["General devise of 'all of my mineral interests wherever located'; no tract is described, so a title examiner must tie it to Section 22 through other instruments. The residuary clause gives the rest of the estate to Donna alone.",
               "Executed in 1998 but probated in 2003; recorded after the order admitting will."])
    add("order2003", "order_probate", "Order Admitting Will to Probate", "order-admit-will-m-ketterman", D(2003, 5, 12), D(2003, 5, 28), "DOC", "wp", "modern_gray",
        will="will2003", cause="2003-P-0147", dec="Marvin T. Ketterman", applicant="Donna Ketterman Reyes", capacity="Independent Executor", letters_kind="Testamentary",
        death=D(2003, 3, 2), judge="Hon. Rebecca S. Cano", bond_txt="without bond")
    add("release2005", "release_lease", "Partial Release of Oil and Gas Lease", "partial-release-lease-1960", D(2005, 9, 14), D(2005, 9, 22), "DOC", "wp", "modern_gray", cover=True, plat=dict(title="SKETCH OF RETAINED 80 ACRES - N/2 OF SW/4, SECTION 22", labels=[("SEC. 22", (0.5, 0.06)), ("N/2 SW/4 - 80 AC. RETAINED", (0.25, 0.75)), ("KETTERMAN NO. 1", (0.25, 0.6))], scale="NOT TO SCALE"),
        lease="lease1960", title="PARTIAL RELEASE OF OIL AND GAS LEASE", margin_word="Partial release", gor="Delaware Basin Operating, Inc., a Texas corporation", gor_res="Midland, Texas",
        sign=[("Delaware Basin Operating, Inc., by Carol S. Whitfield", "Land Manager")], corp=("Delaware Basin Operating, Inc.", "Texas corporation"),
        scope_txt="all of the above described land lying outside the 80-acre proration unit comprising the N/2 of the SW/4 of Section 22, and as to all depths below one hundred feet (100') below the stratigraphic equivalent of the base of the Ellenburger formation",
        extra="Lessee retains the lease as to the 80-acre proration unit described above, from the surface to the stated depth, and Lessee's rights under the lease as to such retained lands are not released.",
        reason="This release is made pursuant to Rider A (Pugh clause) and Rider B (depth limitation) of the lease.",
        reservations_key="Lessee retains the lease as to the 80-acre proration unit described above, from the surface to the stated depth, and Lessee's rights under the lease as to such retained lands are not released.",
        traps=["Partial release: lease retained only as to the 80-acre proration unit in the N/2 of the SW/4 of Section 22 and above 100 feet below the Ellenburger; all other lands and depths are released.",
               "The retained unit acreage is stated by aliquot parts, not by a metes and bounds survey."])
    add("lease2008", "lease", "Oil, Gas and Mineral Lease", "oil-gas-lease-estate-ketterman-redbluff", D(2008, 5, 19), D(2008, 6, 2), "DOC", "wp", "modern",
        gor="Donna Ketterman Reyes, Independent Executor of the Estate of Marvin T. Ketterman, Deceased, and Calvin R. Osgood, a married man dealing in his separate property", gee="Redbluff Resources II, LLC, a Texas limited liability company",
        addr="1200 W. Texas Ave., Midland, Texas 79701", sign=[("Donna Ketterman Reyes", "Independent Executor"), ("Calvin R. Osgood",)],
        legal=LEGAL_ALL, acres="640", term_txt="three (3)", bonus="One Thousand Five Hundred and No/100 Dollars ($1,500.00) per net mineral acre", royalty="one-fourth (1/4)", shutin="$10.00",
        pugh="Notwithstanding anything contained herein to the contrary, at the end of the primary term and any extension, this lease shall terminate as to all lands and depths not included within a producing pooled unit, or within a unit for which a drilling permit has been issued and drilling operations are conducted in good faith, and Lessee shall file a release of all lands so terminated within sixty (60) days.",
        depth="This lease shall cover only those depths from the surface of the earth to one hundred feet (100') below the stratigraphic equivalent of the base of the Wolfcamp formation, as found at 9,870 feet in the Redbluff Ketterman No. 1H well, and all depths below are excepted from this lease and reserved to Lessor.",
        warranty_rider="Notwithstanding paragraph 10 of the printed form, Lessor warrants title only by, through and under Lessor, but not otherwise, and the warranty of title in paragraph 10 is hereby deleted.",
        warranty_key="special (rider C deletes the printed general warranty; Lessor warrants only by, through and under Lessor)",
        exhibit="Section 22, Block 53, Township 7, Texas and Pacific Railway Company Survey, Reeves County, Texas, Abstract No. 4172, containing 640 acres, more or less, together with all of Lessor's interest in the minerals therein, being an undivided seven-sixteenths (7/16) of the oil, gas and other minerals, subject to the nonparticipating royalty and term royalty interests of record.",
        exhibit_mb=None, cover=True,
        reservations_key="All depths below 100 feet below the stratigraphic equivalent of the base of the Wolfcamp formation are excepted and reserved to Lessor; Pugh clause (rider A)",
        traps=["Pugh clause (Rider A) and depth severance (Rider B: surface to 100 feet below the stratigraphic equivalent of the base of the Wolfcamp) together limit the lease to the producing unit and depths.",
               "Rider C deletes the printed general warranty (para. 10) and substitutes a special warranty; the printed form and the rider conflict and the rider controls (para. 11).",
               "Lessor signs as executor for the Estate, but the 2003 will devised the minerals directly to Donna and Calvin; executor's authority to lease depends on the independent administration and the will.",
               "Royalty is 1/4; any floating NPRI (see 2016 royalty deed) computes at 1/4."])
    add("pool2011", "pooling", "Designation of Pooled Unit", "designation-pooled-unit-ketterman-a", D(2011, 3, 18), D(2011, 3, 30), "DOC", "wp", "modern", cover=True, plat=dict(title="UNIT PLAT - KETTERMAN-HAGEN UNIT A (1,280 AC.)", route=[(0.08, 0.5), (0.92, 0.5)], route_label="1H LATERAL", labels=[("SEC. 22", (0.27, 0.8)), ("SEC. 23", (0.73, 0.8)), ("BLK. 53, T-7, T&P RY. CO. SVY.", (0.5, 0.1))], scale="NOT TO SCALE"),
        gor="Redbluff Resources II, LLC, a Texas limited liability company", unit="Ketterman-Hagen Unit A (horizontal)", unit_acres="1,280",
        unit_legal="all of Section 22 and all of Section 23, Block 53, Township 7, Texas and Pacific Railway Company Survey, Reeves County, Texas, containing 1,280 acres, more or less",
        leases=["{LEASE2008}", "Oil and gas lease(s) covering Section 23 (Abstract No. 4173), not part of this chain"], sign=[("Redbluff Resources II, LLC, by Jason T. Mabry", "Land Manager")],
        corp=("Redbluff Resources II, LLC", "Texas limited liability company"), effective=D(2011, 3, 1),
        terms="The Unit is created for the drilling of one or more horizontal wells. Production allocated to the tracts within the Unit shall be allocated in the proportion that the surface acres of each tract (or the perforated lateral length within each tract, as the Railroad Commission may permit) bear to the total acreage of the Unit. Each lease is amended only to the extent necessary to give effect to the Unit.",
        traps=["Horizontal unit of 1,280 acres pools Section 22 with Section 23 (Abstract No. 4173), the section named in the 1949 scrivener's error; verify that the unit was not mis-pooled.",
               "The 2008 lease limits depth to the base of the Wolfcamp + 100 ft; unit operations below that depth would not be covered as to the lessors.",
               "Unit acreage is expressed in surface acres with allocation 'or perforated lateral length'; the allocation formula is optional on the face of the instrument."])
    add("swd2012", "special_warranty", "Special Warranty Deed", "special-warranty-hagen-cedar-ridge-surface", D(2012, 7, 12), D(2012, 7, 19), "DOC", "wp", "modern", exhibit_mb=("the Northeast corner", 320), cover=True,
        gor="Hagen Land and Cattle Company, a Texas general partnership", gee="Cedar Ridge Ranch Holdings, LLC, a Texas limited liability company", sign=[("Hagen Land and Cattle Company, by Wm. J. Hagen", "General Partner")],
        legal=LEGAL_E2, cons="Ten Dollars ($10.00) and other good and valuable consideration",
        reservation="EXCEPTING and RESERVING unto Grantor, its successors and assigns, all oil, gas and other minerals, if any, owned by Grantor in and under the above described land.",
        minerals="no - all oil, gas and other minerals, if any, reserved", frac="the East Half (E/2) of Section 22, surface only (grantor's minerals, if any, reserved)", ack_corp=("Hagen Land and Cattle Company", "Texas general partnership"),
        traps=["Grantor's mineral reservation covers only minerals 'if any, owned by Grantor'; Hagen's 1991 deed excepted all minerals, so the reservation reserves nothing and there is no after-acquired clause."])
    add("roy2016", "royalty_deed", "Royalty Deed (Non-Participating Royalty)", "royalty-deed-reyes-wolfcamp-royalty-floating", D(2016, 2, 24), D(2016, 3, 3), "DOC", "wp", "modern", exhibit_mb=("the Southwest corner", 640), cover=True,
        gor="Donna Ketterman Reyes, a married woman dealing in her separate property", gee="Wolfcamp Royalty Partners, LP, a Texas limited partnership", sign=[("Donna Ketterman Reyes",)], legal=LEGAL_ALL,
        interest_clause="a non-participating royalty interest equal to an undivided one-fourth (1/4) of the royalty provided under the Oil, Gas and Mineral Lease dated May 19, 2008, recorded in {LEASE2008}, and under any renewal, extension or replacement lease, being an undivided one-eighth (1/8) of 8/8ths of all oil, gas and other minerals produced and saved from, and that may hereafter be produced and saved from, the following described land:",
        royalty_key="yes - NPRI equal to 1/4 of the lease royalty; also described as 1/8 of 8/8ths (internally inconsistent when the lease royalty is 1/4)",
        frac="an undivided one-fourth (1/4) of the royalty provided under the Oil, Gas and Mineral Lease dated May 19, 2008 ... being an undivided one-eighth (1/8) of 8/8ths",
        after_acq=True,
        traps=["Floating vs fixed ambiguity: '1/4 of the royalty' under a 1/4 lease is 1/16 of 8/8ths, but the deed also says 'being 1/8 of 8/8ths'. The two descriptions conflict; floating language ('of the royalty') usually controls.",
               "Royalty conveyed under all 'renewal, extension or replacement' leases; the grantor's mineral interest is only part of the 7/16 estate and 1/2 of the devise.",
               "After-acquired title clause present."])
    add("dot2018", "deed_of_trust", "Deed of Trust", "dot-cedar-ridge-permian-ag-credit", D(2018, 7, 5), D(2018, 7, 16), "DOC", "wp", "modern", exhibit_mb=("the Northeast corner", 320),
        gor="Cedar Ridge Ranch Holdings, LLC, a Texas limited liability company", gor_res="of Reeves County, Texas", trustee="Michael S. Treadwell", ben="Permian Ag Credit Association",
        amount="One Million Two Hundred Fifty Thousand Dollars ($1,250,000.00)", rate="5.25% per annum", maturity="July 1, 2038", legal=LEGAL_E2,
        sign=[("Cedar Ridge Ranch Holdings, LLC, by Evan R. Prater", "Manager")], ack_corp=("Cedar Ridge Ranch Holdings, LLC", "Texas limited liability company"),
        mineral_clause="Grantor's interest in the Property is limited to the surface estate; no minerals are pledged.", cover=True,
        traps=["Deed of trust on the E/2 (surface only); released by Release of Lien in 2021."])
    add("heir2020", "heirship", "Affidavit of Heirship", "affidavit-heirship-opal-hargis", D(2020, 2, 18), D(2020, 2, 27), "DOC", "wp", "modern_gray", cover=True,
        title="AFFIDAVIT OF HEIRSHIP", aff1="Teresa L. Montalvo", aff2="Russell E. Beck", dec="Opal V. Hargis", male=False, since="1960",
        facts=["The decedent, Opal V. Hargis (formerly Opal V. Vandiver), died intestate on September 9, 2019, in Reeves County, Texas, and no will has been probated and no administration has been had upon her estate.",
               "The decedent was married once, to Dale M. Hargis, who died in 1994. They had two children, Raymond T. Hargis and Beverly H. Santos, both living, and a third child, Carol A. Hargis, who died in 2008 leaving one daughter, Mia C. Hargis.",
               "The decedent had no other children, living or dead, and no adopted children, and her heirs are: Raymond T. Hargis, Beverly H. Santos and Mia C. Hargis, who takes her mother's share.",
               "The decedent was a child of Ruben D. Vandiver and Pearl A. Vandiver, both deceased."],
        legal=LEGAL_W2, heirs_key="Raymond T. Hargis; Beverly H. Santos; Mia C. Hargis (per stirpes for deceased daughter Carol A. Hargis)",
        traps=["Heirship by affidavit only; shares not stated (per stirpes implied). Affiants (neighbors) may lack personal knowledge of Mia C. Hargis's age or marital status, and the affidavit does not address Opal's husband's separate or community property.",
               "Affidavit identifies the W/2 only; Opal's interest in the royalty (not the W/2 minerals alone) and the 1967 partition tract assigned to her are not described."])
    add("reldot2021", "release_dot", "Release of Lien", "release-lien-permian-ag-credit", D(2021, 11, 9), D(2021, 11, 18), "DOC", "wp", "modern", cover=True,
        dot="dot2018", title="RELEASE OF LIEN", gor="Permian Ag Credit Association", gor_res="Pecos, Texas",
        sign=[("Permian Ag Credit Association, by Linda K. Dorsey", "Vice President")], corp=("Permian Ag Credit Association", "Texas agricultural credit association"))
    add("mdeed2022", "mineral_deed", "Mineral Deed (Depth Limited)", "mineral-deed-hargis-heirs-saragosa-depth", D(2022, 4, 4), D(2022, 4, 12), "DOC", "wp", "modern", exhibit_mb=("the Northwest corner", 160), cover=True,
        gor="Raymond T. Hargis, a single man, and Beverly H. Santos, a married woman dealing in her separate property", gee="Saragosa Minerals, LLC, a Texas limited liability company",
        sign=[("Raymond T. Hargis",), ("Beverly H. Santos",)], legal=LEGAL_N2W2, warranty="special",
        interest_clause="all of Grantors' undivided interest in the oil, gas and other minerals in and under, and that may be produced from, the following described land, LIMITED, however, to those depths from the surface of the earth down to one hundred feet (100') below the stratigraphic equivalent of the base of the Wolfcamp formation, as found at 9,870 feet in the Redbluff Ketterman No. 1H well:",
        frac="all of Grantors' undivided interest in the oil, gas and other minerals, limited to the surface down to 100 feet below the stratigraphic equivalent of the base of the Wolfcamp formation (9,870 feet)",
        reservation="EXCEPTING and RESERVING unto Grantors all oil, gas and other minerals below the depth of one hundred feet (100') below the stratigraphic equivalent of the base of the Wolfcamp formation, as found at 9,870 feet in the Redbluff Ketterman No. 1H well, together with all rights of ingress and egress as to such depths.",
        minerals="yes - Grantors' undivided interest, depth-limited (surface to 100 feet below the base of the Wolfcamp)", after_acq=True,
        traps=["Depth severance: mineral estate divided horizontally at 100 feet below the stratigraphic equivalent of the base of the Wolfcamp (found at 9,870 feet in a named well); the minerals below are reserved to Grantors. Fraction of the grantors' interest is not stated (all of Grantors' undivided interest).",
               "Grantors acquired by intestate succession from Opal V. Hargis (see 2020 heirship), but the heirship named Mia C. Hargis as a third heir who does not join this deed.",
               "Legal limited to the N/2 of the W/2, the tract assigned to Ned R. Vandiver under the 1967 partition; Opal's partition tract is the S/2 of the W/2. The legal description does not match her tract.",
               "After-acquired title clause present."])
    add("qc2023", "quitclaim", "Quitclaim Deed", "quitclaim-g-vandiver-saragosa", D(2023, 8, 7), D(2023, 8, 15), "DOC", "wp", "modern", exhibit_mb=("the Southwest corner", 160), cover=True,
        gor="Glenn R. Vandiver, a married man dealing with his separate property", gee="Saragosa Minerals, LLC, a Texas limited liability company", sign=[("Glenn R. Vandiver",)], legal=LEGAL_S2W2,
        interest_clause="all of Grantor's right, title and interest, if any, in and to the oil, gas and other minerals in and under the following described land situated in %s County, Texas:" % COUNTY,
        frac="all of Grantor's right, title and interest, if any (no fraction stated)",
        traps=["Quitclaim of an unspecified interest ('if any'): conveys only Grantor's actual interest (1/6 of the W/2 minerals decreed in 1965 and any share from Pearl A. Vandiver's heirs). No warranty and no after-acquired title.",
               "Grantor's spouse does not join; separate-property recital only."])
    add("stip2024", "stipulation", "Stipulation of Interest", "stipulation-of-interest-llano-verde", D(2024, 8, 15), D(2024, 8, 26), "DOC", "wp", "modern",
        title="STIPULATION OF INTEREST", payor="Llano Verde Energy Operating, LLC", well="Ketterman-Hagen Unit A #1H and #2H", unit="Ketterman-Hagen Unit A (horizontal)", legal="all of Section 22 and all of Section 23, Block 53, Township 7, Texas and Pacific Railway Company Survey, Reeves County, Texas, containing 1,280 acres, more or less",
        rows=[["Saragosa Minerals, LLC", "Mineral (depth-limited)", ".0023437500", "depth-limited"],
              ["Wolfcamp Royalty Partners, LP", "NPRI (1/4 of royalty)", ".0009765625", "per Instr. 2016"],
              ["Raymond T. Hargis", "Mineral (below limit)", ".0011718750", "reserved depths"],
              ["Donna Ketterman Reyes", "Mineral/Royalty", ".0019531250", "lessor, 2008 lease"],
              ["Pioneer Mineral Holdings, Inc.", "Mineral (1/2 of 1/3)", ".0008138021", ""]],
        owners_key="Saragosa Minerals, LLC; Wolfcamp Royalty Partners, LP; Raymond T. Hargis; Donna Ketterman Reyes; Pioneer Mineral Holdings, Inc.",
        decimals_key=".00234375; .0009765625; .001171875; .001953125; .0008138021",
        sign=[("Llano Verde Energy Operating, LLC, by Alana R. Quick", "Vice President, Land"), ("Saragosa Minerals, LLC, by Jesse W. Cruz", "Manager")],
        extra="Owners stipulate that each decimal is computed on the basis of the title opinion dated August 1, 2024, and that depth-limited mineral interests share only in production from depths within their limits.", cover=True,
        traps=["Stipulated decimals credit Saragosa with a mineral interest only to the base of the Wolfcamp + 100 feet while operator allocates unit production by lateral length; reserved-depth interest of Hargis is paid separately.",
               "Pioneer Mineral Holdings decimal (.0008138021) is derived from 'one-half of one-third' without a stated reading of Grantor's interest (see 1994 deed)."])
    return reg, L

# ----------------------------------------------------------------------------
# Rendering: chrome, recording artifacts, covers, per-instrument pipeline
# ----------------------------------------------------------------------------
PRODUCERS = ["Canon iR-ADV C5535 scan", "Xerox WorkCentre 7855", "Kodak i1440 Scanner", "ScanSoft PaperPort 11", "Fujitsu fi-7160",
             "Reeves County Clerk Imaging (fictional)", "Lanier LD160 Scan"]
STAMP_COLORS = ["stampA", "stampB", "stampC", "ink"]
MON3 = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]


def stamp_date(d):
    return "%s %d %d" % (MON3[d.month - 1], d.day, d.year)


def short_name(party):
    p = re.sub(r"^the\s+", "", party.strip(), flags=re.I)
    p = re.split(r",| and ", p)[0].strip()
    w = p.split()
    if any(x in p for x in ("Bank", "Company", "Association", "Corporation", "State of Texas", "Water")):
        return " ".join(w[:3])
    return w[-1] if w else p


def combined(pg):
    out = Image.new("L", (pg.w, pg.h), 0)
    for k in ("ink", "print", "hand"):
        if k in pg.masks:
            out = ImageChops.lighter(out, pg.masks[k])
    return out


def make_chrome(I, rng):
    st = I.style
    ref = I.ref

    def chrome(flow, pg, idx):
        cfg = flow.cfg
        if st == "longhand":
            rule = pg.d("rule")
            y = cfg.top + cfg.base_off * cfg.line_h + 9
            while y < flow.ph - 110:
                rule.line([(cfg.left - 28, y + rng.uniform(-.8, .8)), (PW - 70, y + rng.uniform(-.8, .8))], fill=int(rng.uniform(130, 190)), width=1)
                y += cfg.line_h
            red = pg.d("redrule")
            for dx in (34, 40):
                red.line([(cfg.left - dx, 110), (cfg.left - dx, flow.ph - 90)], fill=170, width=1)
            sname = SERIES_NAME[ref["series"]].upper()
            pg.d("print").text((PW / 2, 78), sname + " OF " + COUNTY.upper() + " COUNTY, TEXAS", font=font("georgiab", 26), fill=255, anchor="mm")
            pg.d("print").line([(120, 112), (PW - 70, 112)], fill=235, width=2)
            pg.d("print").text((130, 78), "Vol. %s" % ref["vol"], font=font("georgiab", 30), fill=255, anchor="lm")
            flow.hand_text(pg, PW - 215, 96, str(ref["page"] + idx), "chancery", Cfg(size=44, mask="ink"))
            if idx == 0:
                _margin_summary(flow, I, pg)
        elif st == "form":
            pg.d("print").text((cfg.left, 70), "FORM 88-C (REV. 4-57)   OIL, GAS AND MINERAL LEASE", font=font("arialnb", 19), fill=255, anchor="lm")
            pg.d("print").text((PW - cfg.right, 70), "PECOS STATIONERY CO., PECOS, TEXAS", font=font("arialn", 17), fill=255, anchor="rm")
            pg.d("print").line([(cfg.left, 88), (PW - cfg.right, 88)], fill=235, width=2)
            pg.d("print").rectangle([cfg.left - 18, 105, PW - cfg.right + 18, flow.ph - 100], outline=210, width=2)
        flow._chrome_done = True

    return chrome


def _margin_summary(flow, I, pg):
    k = I.key
    lines = [short_name(k["GRANTOR"]), "to", short_name(k["GRANTEE"]) if k["GRANTEE"] not in ("", "not applicable") else "", I.type_name.split(" (")[0][:16],
             "Filed " + "%s %d" % (MON3[I.rec.month - 1].title(), I.rec.day), "%d" % I.rec.year]
    y = 380
    f = "chancery"
    for i, t in enumerate(lines):
        if not t:
            continue
        if i == 3:
            y += 26
        sz = 28
        while font(f, sz).getlength(t) > 190 and sz > 18:
            sz -= 1
        flow.hand_text(pg, 22, y, t, f, Cfg(size=sz, mask="ink", jit=1.4))
        y += 42


def build_cover(I, n_total, rng, ph):
    pg = Page(PW, ph, "R")
    r = I.ref
    d = pg.d("print")
    d.text((PW / 2, 150), "REEVES COUNTY CLERK", font=font("arialb", 38), fill=255, anchor="mm")
    d.text((PW / 2, 200), "RECORDING COVER SHEET", font=font("arialb", 30), fill=255, anchor="mm")
    d.line([(150, 235), (PW - 150, 235)], fill=240, width=3)
    rows = [("Instrument No.", r.get("inst_no") or "Vol. %s Pg. %s" % (r["vol"], r["page"])),
            ("Document Type", I.type_name.upper()), ("Date of Document", d_short(I.ex)), ("Number of Pages", str(n_total)),
            ("Grantor / Assignor", strip_markup(I.key["GRANTOR"])[:80]), ("Grantee / Assignee", strip_markup(I.key["GRANTEE"])[:80]),
            ("Legal (abbrev.)", "Sec. 22, Blk. 53, T-7, T&P Ry. Co. Svy., A-4172, Reeves Co., TX"), ("Return To", "Land Dept., c/o Box 1137, Pecos, Texas 79772"),
            ("Recording Fee", "$%d.00" % (14 + 8 * n_total))]
    y = 300
    for lab, val in rows:
        d.text((170, y), lab.upper() + ":", font=font("arialb", 22), fill=255, anchor="ls")
        cf = font("courier", 23)
        wrapped, cur = [], ""
        for w in val.split():
            if cf.getlength((cur + " " + w).strip()) <= PW - 150 - 565:
                cur = (cur + " " + w).strip()
            else:
                wrapped.append(cur)
                cur = w
        wrapped.append(cur)
        for li, ln in enumerate(wrapped[:2]):
            pg.d("ink").text((562, y - 22 * (len(wrapped[:2]) - 1) + li * 26), ln, font=cf, fill=int(rng.uniform(190, 250)), anchor="ls")
        d.line([(555, y + 8), (PW - 150, y + 8)], fill=200, width=1)
        y += 78
    barcode(pg, rng, 170, y + 30, 520, 80, (r.get("inst_no") or "%s%s" % (r["vol"], r["page"])).replace("-", ""))
    d.text((170, y + 160), "THIS PAGE IS NOT PART OF THE INSTRUMENT. RECORDING INFORMATION ON THE FOLLOWING PAGES CONTROLS.", font=font("arialn", 18), fill=255, anchor="ls")
    return pg


def decorate(I, flow, rng, extra_hard):
    """Recording stamps, page stamps, footers, margin notes."""
    ref, st = I.ref, I.style
    n = len(flow.pages)
    year = I.rec.year
    clerk = clerk_for(year)
    for idx, pg in enumerate(flow.pages):
        cfg = flow.cfg
        if st in ("typed", "form"):
            if ref.get("vol") is not None:
                pn = ref["page"] + idx
                if idx == 0:
                    col = rng.choice(STAMP_COLORS[:3])
                    faint = I.P.get("faint_stamp", False)
                    partial = (not faint) and rng.random() < .15
                    dbl = rng.random() < .30
                    ang = rng.uniform(-7, 6)
                    sx = PW - 640 + rng.randint(-30, 60) + (140 if partial else 0) - (40 if st == "form" else 0)
                    box = rubber_stamp(pg, rng, sx, rng.randint(22, 52) if st == "typed" else rng.randint(112, 124), ["FILED FOR RECORD", "%s  at %s" % (stamp_date(I.rec), I.P.get("time", "10:15 A.M.")),
                                       clerk.upper() + ", CLERK, %s CO." % COUNTY.upper()], col, ang, size=25, double=dbl, partial=partial, faint=faint)
                    if partial or dbl:
                        extra_hard.append(dict(page=1, kind=("rubber stamp partly off the page edge" if partial else "double-struck rubber stamp"),
                                               true_value="FILED FOR RECORD %s at %s, %s, Clerk" % (stamp_date(I.rec), I.P.get("time", "10:15 A.M."), clerk),
                                               bbox=box, field="DATE RECORDED (stamp is readable but degraded)"))
                    if faint:
                        extra_hard.append(dict(page=1, kind="faint rubber stamp", true_value="FILED FOR RECORD %s at %s, %s, Clerk" % (stamp_date(I.rec), I.P.get("time", "10:15 A.M."), clerk),
                                               bbox=box, field="DATE RECORDED (also RECORDING REF stamp)"))
                    col2 = rng.choice(["stampB", "stampC", "stampA"])
                    rubber_stamp(pg, rng, 120 + rng.randint(-20, 40), flow.ph - 150 - rng.randint(0, 20), ["RECORDED", "VOL. %s  PAGE %d" % (ref["vol"], pn), SERIES_NAME[ref["series"]].upper()],
                                 col2, rng.uniform(-3, 3), size=24, double=rng.random() < .2)
                else:
                    pg.d("stampB").text((PW - 170, 78), "VOL. %s  PG. %d" % (ref["vol"], pn), font=font("arialnb", 24), fill=225, anchor="rm")
            if idx >= 1 and st == "typed":
                flow.type_text(pg, PW / 2 - 20, flow.ph - 110, "-%d-" % (idx + 1), cfg.family, cfg.size, "ink")
        elif st == "wp":
            _wp_decor(I, flow, pg, idx, n, rng)
        elif st == "longhand":
            if year >= 1905 and idx == 0 and rng.random() < .55:
                rubber_stamp(pg, rng, PW - 470, flow.ph - 190, ["RECORDED", "Vol. %s  Pg. %s" % (ref["vol"], ref["page"])], "stampA", rng.uniform(-5, 5), size=26)
    cfg = flow.cfg
    for (pgi, text, kind) in I.margin_notes:
        pg = flow.pages[min(pgi, n - 1)]
        mask = "pencil" if kind == "pencil" else "hand"
        f = font("bradley", 28)
        avail = (cfg.left - 25) if st != "longhand" else 205
        if st == "form":
            avail = 99999
        fs = 28
        while fs > 17 and max(font("bradley", fs).getlength(w) for w in text.split()) > (cfg.left - 25 if st != "longhand" else 205) and st != "form":
            fs -= 1
        f = font("bradley", fs)
        words, lines, cur = text.split(), [], ""
        for w in words:
            t = (cur + " " + w).strip()
            if f.getlength(t) <= avail:
                cur = t
            else:
                lines.append(cur)
                cur = w
        lines.append(cur)
        y = int(flow.ph * 0.56) + rng.randint(-40, 40)
        x = 14 if st != "longhand" else 12
        if st == "form":
            lines = [text]
            x, y = int(PW * 0.45), flow.ph - 62
        for ln in lines:
            flow.hand_text(pg, x, y, ln, "bradley", Cfg(size=fs, mask=mask, jit=1.6))
            y += fs + 8


def _wp_decor(I, flow, pg, idx, n, rng):
    ref = I.ref
    off = getattr(flow, "cover_off", 0)
    k = n
    if ref.get("inst_no"):
        if idx == 0:
            d = pg.d("print")
            f = font("arialb", 19)
            lines = ["Instrument # %s" % ref["inst_no"], "Recorded: %s  %s" % (d_short(I.rec).replace("/", "/"), time_s(rng)),
                     "Pages: %d   Fee: $%d.00" % (n + off, 14 + 8 * (n + off)), "%s, County Clerk" % clerk_for(I.rec.year), "%s County, Texas" % COUNTY]
            for i, t in enumerate(lines):
                d.text((PW - 150, 52 + i * 26), t, font=f if i == 0 else font("arial", 18), fill=255, anchor="rm")
            barcode(pg, rng, 150, 40, 330, 54, ref["inst_no"].replace("-", ""))
        pg.d("print").text((PW / 2, flow.ph - 95), "Instrument # %s   -   Page %d of %d" % (ref["inst_no"], idx + 1 + off, n + off), font=font("arial", 18), fill=255, anchor="mm")
    else:
        if idx == 0:
            col = rng.choice(["stampA", "stampB", "stampC"])
            rubber_stamp(pg, rng, PW - 600 + rng.randint(-20, 30), rng.randint(34, 70),
                         ["FILED FOR RECORD", "%s  %s" % (stamp_date(I.rec), time_s(rng)), clerk_for(I.rec.year).upper() + ", COUNTY CLERK"], col, rng.uniform(-4, 4),
                         size=24, double=rng.random() < .25)
            rubber_stamp(pg, rng, 140, flow.ph - 165, ["RECORDED IN", "VOL. %s  PAGE %d" % (ref["vol"], ref["page"]), "OFFICIAL PUBLIC RECORDS"], "stampB", rng.uniform(-3, 3), size=22)
        else:
            pg.d("stampB").text((PW - 160, 70), "VOL. %s  PG. %d" % (ref["vol"], ref["page"] + idx), font=font("arialnb", 22), fill=225, anchor="rm")
        pg.d("print").text((PW / 2, flow.ph - 95), "- %d -" % (idx + 1), font=font("times", 22), fill=255, anchor="mm")


INS_WORDS = ["appurtenances", "singular", "premises", "forever", "heirs", "lawfully", "whomsoever", "usual", "thereto", "against", "above", "described"]


def inject_artifacts(I):
    """Typed x-outs (wrong word struck, correct word follows) and handwritten interlineations (a real word of the text
    drawn above the line with a caret and initials). The visible text still reads exactly as the key says."""
    if I.style not in ("typed", "longhand"):
        return
    rng = random.Random("inject-" + I.id)
    cands = [i for i, b in enumerate(I.blocks) if b[0] == "p" and "<" not in b[1] and b[1].startswith(("TO HAVE", "It is further", "WITNESS", "Witness", "Grantee shall", "This conveyance"))]
    if not cands:
        return
    h = _h(I.id)
    one_ins = I.style == "typed" and I.P.get("spacing", "double") != "single" and h % 3 != 1
    do_x = (h % 2 == 0) or I.style == "longhand"
    for j, ci in enumerate(cands[:2]):
        b = I.blocks[ci]
        words = b[1].split(" ")
        idxs = [k for k, w in enumerate(words) if re.fullmatch(r"[a-z]{4,}", w)]
        if not idxs:
            continue
        k = rng.choice(idxs)
        if j == 0 and do_x:
            wrong = rng.choice([words[k][:-1], words[k] + "e", words[k][:2] + words[k][3:], words[k] + " " + words[k]]) if len(words[k]) > 4 else words[k] + "x"
            words[k] = "<xout>%s</xout> %s" % (wrong, words[k])
        elif j == 0 or (j == 1 and one_ins):
            for kk in idxs:
                if words[kk] in INS_WORDS and I.style == "typed" and one_ins:
                    words[kk] = "<ins>%s</ins>" % words[kk]
                    break
        I.blocks[ci] = (b[0], " ".join(words)) + tuple(b[2:])


# ----------------------------------------------------------------------------
def render_instrument(I, seed, extra_hard):
    rng = random.Random("%s-render-%s" % (seed, I.id))
    I.P.setdefault("time", time_s(random.Random("t-%s-%s" % (seed, I.id))))
    I.P.setdefault("hour", I.P["time"].split(":")[0])
    cfg = make_cfg(I, rng)
    ph = PH["legal"] if (I.style == "typed" and I.P.get("legal_size")) else PH["letter"]
    chrome = make_chrome(I, rng)
    flow = Flow(rng, cfg, ph, chrome=chrome, side_start="R" if rng.random() < .5 else "L")
    blocks = list(I.blocks)
    sg = I.P.get("sign") or [("A. B. Clerk",)]
    flow.initials = "".join(w[0] for w in officer(sg[0][0]).replace(".", " ").split() if w[0].isupper()) + "."
    if I.style == "longhand" or (I.style == "typed" and I.rec.year < 1955 and I.kind not in ("division_order",) and (_h(I.id) % 3 == 0)):
        blocks.append(("cert",))
    run_blocks(flow, I, blocks, rng)
    flow.cover_off = 1 if (I.P.get("cover") and I.style == "wp") else 0
    decorate(I, flow, rng, extra_hard)
    pages = flow.pages
    if I.P.get("cover") and I.style == "wp":
        cv = build_cover(I, len(pages) + 1, rng, ph)
        pages = [cv] + pages
        # shift hard-spot page refs happen via page index at report time
    return pages, flow


def scan_pages(I, pages, seed):
    rng = random.Random("%s-scan-%s" % (seed, I.id))
    out = []
    comb = [combined(p) for p in pages]
    for i, pg in enumerate(pages):
        prof = dict(PROFILES[I.med])
        if I.med == "book_old" and rng.random() < .4:
            prof = dict(PROFILES["book_cleaner"])
        rev = comb[(i + 1) % len(pages)] if len(pages) > 1 else None
        im = compose(pg, prof, rng, reverse=rev)
        jb, mode, size, q = jpeg_bytes(im, prof, rng)
        out.append((jb, mode, size, im))
    return out

# ----------------------------------------------------------------------------
# Driver: build chain, resolve cross references, render, write key / README
# ----------------------------------------------------------------------------
BUILDERS = {
    "patent": b_patent, "warranty_deed": b_warranty_deed, "special_warranty": b_special_warranty, "quitclaim": b_quitclaim,
    "mineral_deed": b_mineral_deed, "royalty_deed": b_royalty_deed, "surface_deed": b_surface_deed, "correction_deed": b_correction_deed,
    "partition": b_partition, "lease": b_lease, "assignment": b_assignment, "release_lease": b_release_lease,
    "deed_of_trust": b_deed_of_trust, "release_dot": b_release_dot, "easement": b_easement, "heirship": b_heirship, "will": b_will,
    "order_probate": b_order_probate, "letters": b_letters, "ratification": b_ratification, "pooling": b_pooling, "nonprod": b_nonprod,
    "lis_pendens": b_lis_pendens, "judgment": b_judgment, "division_order": b_division_order, "stipulation": b_division_order,
}
MED_OVERRIDE = {"order1928": "micro_neg", "lis1964": "micro_pos", "judg1965": "micro_pos", "letters1928": "micro_pos", "esmt1977": "copy_book"}
ERA_LABEL = {"A": "1889-1922 (clerk longhand copies / early records)", "B": "1923-1979 (typed, photostat, printed forms)", "C": "1980-2024 (word-processed, copy/modern scans)"}
REF_RE = re.compile(r"\{([A-Z0-9]+)\}")


def resolve(obj, reg):
    if isinstance(obj, str):
        return REF_RE.sub(lambda m: reg.text(m.group(1).lower()), obj)
    if isinstance(obj, list):
        return [resolve(o, reg) for o in obj]
    if isinstance(obj, tuple):
        return tuple(resolve(o, reg) for o in obj)
    if isinstance(obj, dict):
        return {k: resolve(v, reg) for k, v in obj.items()}
    return obj


def referenced_ids(I, reg):
    text = json.dumps(I.blocks, default=str)
    return sorted(i for i, o in reg.items.items() if i != I.id and o.ref and o.ref["text"] in text)


def ack_detail(I):
    for b in I.blocks:
        if b[0] in ("ack", "jurat"):
            a = b[1]
            return dict(present=a.get("defect") != "no_ack", kind="jurat" if b[0] == "jurat" else "acknowledgment", notary=a["notary"], county=a["county"],
                        date=d_iso(a["date"]), persons=a["persons"], privy_examination_of_wife=bool(a.get("privy")),
                        defect=a.get("defect"), seal=a.get("seal"))
    return dict(present=False, kind="none", note="no notarial certificate on the instrument (not required for this type, or omitted)")


def build_all(seed, only=None):
    rng = random.Random("%s-chain" % seed)
    reg, insts = build_chain(rng)
    for I in insts:
        I.med = MED_OVERRIDE.get(I.id, I.med)
    assign_refs(insts, random.Random("%s-refs" % seed))
    for I in insts:
        I.P = resolve(I.P, reg)
    # build bodies in chronological recording order
    for I in sorted(insts, key=lambda i: (i.rec, i.id)):
        brng = random.Random("%s-body-%s" % (seed, I.id))
        I.hard_fields = I.P.get("hard", {})
        I.blocks = BUILDERS[I.kind](I, reg, brng)
        inject_artifacts(I)
        k = I.key
        k["ISSUES"] = list(I.traps) if I.traps else ["none noted"]
        k["CONFIDENCE"] = "not scored"
    return reg, insts


def provenance(I):
    """Which key strings appear verbatim on the pages (x-outs dropped) and which are summaries."""
    txt = " ".join(x for b in I.blocks for x in b[1:] if isinstance(x, str))
    txt = re.sub(r"<xout>.*?</xout>", "", txt)
    T = re.sub(r"\s+", " ", strip_markup(txt)).lower()
    out = {}
    for f in ("GRANTOR", "GRANTEE", "LEGAL DESC", "FRACTION CONVEYED", "RESERVATIONS"):
        v = re.sub(r"\s+", " ", strip_markup(I.key[f])).lower()
        if v in ("", "none stated") or v.startswith("not applicable"):
            out[f] = "not applicable / none"
        elif v in T:
            out[f] = "verbatim"
        else:
            out[f] = "summary"
    return out


def file_name(n, I):
    return "%02d-%s.pdf" % (n, I.slug)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--seed", default="1917")
    ap.add_argument("--out", default="/Users/loganbrown/Downloads/realistic-titlework")
    ap.add_argument("--only", default="", help="comma list of instrument ids (dev)")
    ap.add_argument("--check-lab", action="store_true", help="after writing, render with pdftoppm -r 144 and measure PNG bytes per file")
    ap.add_argument("--progress", default="")
    ap.add_argument("--lab-only", action="store_true", help="skip generation; only run the lab byte check on an existing --out dir")
    args = ap.parse_args()
    out = args.out
    if args.lab_only:
        check_lab(out, json.load(open(os.path.join(out, "answer_key.json")))["files"])
        return
    os.makedirs(out, exist_ok=True)
    reg, insts = build_all(args.seed)
    order = sorted(insts, key=lambda i: (i.rec, i.id))
    only = set(x for x in args.only.split(",") if x)
    key_files, total_pages = [], 0
    prev_dir = os.path.join(out, "previews")
    os.makedirs(prev_dir, exist_ok=True)
    PREVIEWS = {("wd1892", 0), ("wd1921", 1), ("wd1925", 0), ("roy1948", 0), ("lease1960", 0), ("nonprod1969", 0), ("esmt1977", 2), ("lease2008", 2), ("mdeed2022", 1)}
    for n, I in enumerate(order, 1):
        if only and I.id not in only:
            continue
        extra_hard = []
        pages, flow = render_instrument(I, args.seed, extra_hard)
        hard = []
        for pi, pg in enumerate(pages):
            for hs in pg.hard:
                hard.append(dict(page=pi + 1, kind=hs["kind"], true_value=hs["text"], bbox_px_150dpi=list(hs["bbox"]), field=I.hard_fields.get(hs["text"], "")))
        for h in extra_hard:
            h["page"] = h["page"] + (1 if I.P.get("cover") and I.style == "wp" else 0)
            h["bbox_px_150dpi"] = list(h.pop("bbox")) if h.get("bbox") else []
            hard.append(h)
        scanned = scan_pages(I, pages, args.seed)
        fn = file_name(n, I)
        prng = random.Random("%s-pdf-%s" % (args.seed, I.id))
        write_pdf(os.path.join(out, fn), [(jb, mode, size) for jb, mode, size, _ in scanned],
                  dict(producer=prng.choice(PRODUCERS), date="2024%02d%02d1%d0000" % (prng.randint(1, 9), prng.randint(10, 28), prng.randint(0, 9))))
        for pi, (jb, mode, size, im) in enumerate(scanned):
            if (I.id, pi) in PREVIEWS:
                im.convert("RGB").save(os.path.join(prev_dir, "preview-%02d-%s-p%d.png" % (n, I.id, pi + 1)), optimize=False)
        total_pages += len(scanned)
        k = I.key
        entry = {
            "filename": fn, "id": I.id, "page_count": len(scanned), "era": I.era, "era_label": ERA_LABEL[I.era], "presentation": I.style, "scan_profile": I.med,
            "instrument_type": I.type_name, "date_executed": d_iso(I.ex), "date_recorded": d_iso(I.rec),
            "recording_ref": dict(text=I.ref["text"], short=I.ref["short"], series=SERIES_NAME[I.ref["series"]], volume=I.ref.get("vol"), page=I.ref.get("page"), instrument_no=I.ref.get("inst_no")),
            "grantor": k["GRANTOR"], "grantee": k["GRANTEE"], "legal_description": k["LEGAL DESC"],
            "interest_conveyed": dict(surface=k["SURFACE"], minerals=k["MINERALS"], royalty_npri=k["ROYALTY/NPRI"], fraction_conveyed=k["FRACTION CONVEYED"]),
            "reservations": k["RESERVATIONS"], "warranty_type": k["WARRANTY"], "acknowledgment": ack_detail(I),
            "after_acquired_title": k["AFTER-ACQUIRED TITLE"], "term": k["TERM"],
            "signers": [s[0] for s in I.P.get("sign", [])], "references": referenced_ids(I, reg),
            "traps": list(I.traps), "hard_to_read": hard,
            "lab_fields": {f: k[f] for f in KEY_FIELDS}, "field_provenance": provenance(I),
        }
        key_files.append(entry)
        print("%s  %d pp  %s" % (fn, len(scanned), I.med), flush=True)
        if args.progress:
            with open(args.progress, "a") as fh:
                fh.write("%s rendered %s (%d pp)\n" % (dt.datetime.now().strftime("%H:%M:%S"), fn, len(scanned)))
    if not only:
        key = dict(generator="scripts/generate_realistic_titlework.py", seed=args.seed, note="ALL names, volumes, pages and instrument numbers are fictional. Geography (Reeves/Ward County, T&P Ry. Co. survey) is real but the tract, Abstract Nos. and chain are invented.",
                   lab_fields_order=KEY_FIELDS, total_pages=total_pages, files=key_files)
        with open(os.path.join(out, "answer_key.json"), "w") as fh:
            json.dump(key, fh, indent=2, ensure_ascii=False)
        write_readme(out, args.seed, key_files, total_pages, reg)
    print("TOTAL PAGES", total_pages, "FILES", len(key_files))
    if args.check_lab:
        check_lab(out, key_files)


CHROME_PNG_FACTOR = 1.65   # measured: Chrome canvas.toBlob PNG is 1.35-1.64x a PIL RGBA PNG of the same pixels


def check_lab(out, key_files):
    """Approximate the lab: pdf.js scale 2 -> PNG (RGBA canvas). pdftoppm -r 144 == scale 2 for 72-unit pages.
    The conservative estimate multiplies the PIL RGBA PNG size by the factor measured against real pdf.js in Chrome."""
    import tempfile
    cap = 12_000_000
    tmp = tempfile.mkdtemp(prefix="labcheck-", dir=os.environ.get("TMPDIR", None))
    rows, worst = [], 0
    for e in key_files:
        fn = e["filename"]
        base = os.path.join(tmp, "p")
        subprocess.run(["pdftoppm", "-r", "144", "-png", os.path.join(out, fn), base], check=True)
        pngs = sorted(f for f in os.listdir(tmp) if f.startswith("p-") and f.endswith(".png"))
        tot_raw = tot_rgba = tot_jpg = 0
        for f in pngs:
            path = os.path.join(tmp, f)
            tot_raw += os.path.getsize(path)
            im = Image.open(path)
            b = io.BytesIO()
            im.convert("RGBA").save(b, "PNG")
            tot_rgba += b.tell()
            b2 = io.BytesIO()
            im.convert("RGB").save(b2, "JPEG", quality=85)
            tot_jpg += b2.tell()
            os.remove(path)
        est = int(tot_rgba * CHROME_PNG_FACTOR)
        worst = max(worst, est)
        rows.append((fn, len(pngs), tot_raw, tot_rgba, est, tot_jpg))
    print("\nLAB BYTE CHECK (cap %d). est_chrome_png = PIL RGBA PNG x %.2f (conservative)" % (cap, CHROME_PNG_FACTOR))
    for fn, n, raw, rgba, est, jpg in rows:
        flag = "" if est < cap * 0.85 else "  <-- OVER 85% of cap"
        print("%-62s %2d pp  pdftoppm_png=%9d  rgba_png=%9d  est_chrome_png=%9d  jpeg85=%8d%s" % (fn, n, raw, rgba, est, jpg, flag))
    print("MAX est_chrome_png per file: %d of %d (%.0f%%)" % (worst, cap, 100.0 * worst / cap))
    measured = None
    mpath = os.path.join(out, "lab_byte_check_pdfjs.json")
    if os.path.exists(mpath):
        measured = json.load(open(mpath))
    with open(os.path.join(out, "lab_byte_check.json"), "w") as fh:
        json.dump(dict(cap_bytes=cap, max_pages=60, render_scale=2, page_px_at_scale_2="1224x1584 (letter)", chrome_png_factor=CHROME_PNG_FACTOR,
                       files=[dict(file=fn, pages=n, pdftoppm_png_bytes=raw, pil_rgba_png_bytes=rgba, est_chrome_png_bytes=est, jpeg85_bytes=jpg) for fn, n, raw, rgba, est, jpg in rows]), fh, indent=1)
    rpath = os.path.join(out, "README.md")
    if os.path.exists(rpath):
        txt = open(rpath).read().split("\n## Lab byte budget")[0].rstrip() + "\n"
        txt += "\n## Lab byte budget\n\n- Pages are 612x792 pt (letter) at 150 dpi; the lab renders at scale 2 = 1224x1584 px per page; largest file here: %d pages (lab max 60).\n" % max(r[1] for r in rows)
        txt += "- Cap is 12,000,000 bytes of rendered page images per file. Conservative estimate (PIL RGBA PNG x %.2f): worst file %d bytes (%.0f%% of cap).\n" % (CHROME_PNG_FACTOR, worst, 100.0 * worst / cap)
        if measured:
            mx = max(measured, key=lambda m: m["png_bytes"])
            txt += "- Measured with the vendored pdf.js in headless Chrome at scale 2 (canvas.toBlob PNG, the lab's first encode): worst file `%s` = %d bytes (%.0f%% of cap). The lab falls back to JPEG only if a file exceeds the cap.\n" % (mx["file"], mx["png_bytes"], 100.0 * mx["png_bytes"] / cap)
        open(rpath, "w").write(txt)


def write_readme(out, seed, files, total, reg):
    lines = ["# Realistic fake Texas title work (OCR comparison lab fixtures)", "",
             "Generated by `scripts/generate_realistic_titlework.py --seed %s`. **Everything is fictional**: people, companies, volumes, pages, instrument numbers, clerks and notaries. "
             "Reeves/Ward County and the T&P Ry. Co. survey are real geography only; the tract (Section 22, Block 53, Township 7, Abstract No. 4172) and the chain are invented." % seed, "",
             "%d instruments, %d pages, one instrument per PDF, one chain of title from a 1889 patent to a 2024 stipulation of interest." % (len(files), total), "",
             "## How to use with the OCR lab", "",
             "- Upload up to 10 files at a time (lab limit). Each file is 1-6 pages (lab max 60) and its rendered PNG bytes at scale 2 are under the 12,000,000 byte cap (see `lab_byte_check.json`).",
             "- Score each model's answer against `answer_key.json`. Each file has `lab_fields` with the 18 prompt fields in the exact order of `ABSTRACTION_PROMPT`: "
             "DOC TYPE, DATE EXECUTED, DATE RECORDED, RECORDING REF, GRANTOR, GRANTEE, LEGAL DESC, SURFACE, MINERALS, ROYALTY/NPRI, TERM, AFTER-ACQUIRED TITLE, FRACTION CONVEYED, RESERVATIONS, WARRANTY, ACKNOWLEDGMENT, ISSUES, CONFIDENCE (CONFIDENCE is not scored).",
             "- Match names and dates tolerantly (dates have ISO forms in `date_executed` / `date_recorded`). Each file has `field_provenance`: `verbatim` means the key string appears on the page as written; `summary` means the key paraphrases it (for example a composite FRACTION CONVEYED).",
             "- `ISSUES` in `lab_fields` is the list of `traps`: things a careful examiner should catch. A model that writes `none noted` on a file with traps missed them.",
             "- `hard_to_read` lists deliberately degraded spots (smudged fraction, faint stamp) with the true values. Models should either read them or write `ILLEGIBLE - VERIFY MANUALLY`; a confident wrong value is the worst result.", "",
             "## Eras and scan styles", "",
             "- 1889-1922 (A): clerk's longhand copies in deed-record books. Ruled ledger lines, margin summaries, book/page headers, gutter shadow, foxing, bleed-through, JPEG.",
             "- 1923-1979 (B): typed originals (Courier / American Typewriter, uneven strike, x-outs, interlineations in hand), printed oil and gas lease forms with typed fill-ins and rider, carbon copies, photostat/microfilm (some white-on-black), folds and punch holes, rubber FILED/RECORDED stamps, embossed notary seals.",
             "- 1980-2024 (C): word-processed, photocopy/fax-like scans with black borders and toner speckle, later e-recording header and footer, cover sheets, inked notary stamps.", "",
             "## Files", "", "| # | file | pages | type | executed | recorded | era |", "|---|------|-------|------|----------|----------|-----|"]
    for i, e in enumerate(files, 1):
        lines.append("| %d | %s | %d | %s | %s | %s | %s |" % (i, e["filename"], e["page_count"], e["instrument_type"], e["date_executed"], e["date_recorded"], e["era"]))
    lines += ["", "## Deliberate title traps (summary)", ""]
    trapfiles = [(e["filename"], t) for e in files for t in e["traps"]]
    for fn, t in trapfiles:
        lines.append("- `%s`: %s" % (fn, t))
    lines += ["", "## Hard-to-read spots", ""]
    for e in files:
        for h in e["hard_to_read"]:
            lines.append("- `%s` p.%d: %s `%s` %s" % (e["filename"], h["page"], h["kind"], h["true_value"], ("(" + h.get("field", "") + ")") if h.get("field") else ""))
    lines += ["", "## Regenerate", "", "```", "/Users/loganbrown/.hermes/cache/scratch/titlework-gen-venv/bin/python scripts/generate_realistic_titlework.py --seed %s --out ~/Downloads/realistic-titlework --check-lab" % seed, "```", ""]
    with open(os.path.join(out, "README.md"), "w") as fh:
        fh.write("\n".join(lines))


if __name__ == "__main__":
    main()
