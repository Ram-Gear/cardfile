"""Render synthetic business-card test images for the 'Scan business card' feature.

Everything here is made up: fictional people and companies, 555-01xx phone numbers (reserved for
fiction) and example.com/.net/.org domains (reserved for documentation). Writes PNG/JPEG images plus
truth.json (the fields the parser should find) to tools/testdata/scan/.

    python3 tools/make_scan_testcards.py
"""
import json, math, os, random
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'testdata', 'scan')
FONTS = '/usr/share/fonts/truetype'


def font(path, size, bold=False):
    """Load a TTF; variable fonts get their Bold/Regular instance."""
    for p in path if isinstance(path, (list, tuple)) else [path]:
        if os.path.exists(p):
            f = ImageFont.truetype(p, size)
            try:
                f.set_variation_by_name('Bold' if bold else 'Regular')
            except Exception:
                pass
            return f
    return ImageFont.truetype(f'{FONTS}/dejavu/DejaVuSans{"-Bold" if bold else ""}.ttf', size)


LATO = f'{FONTS}/sand-box/google/Lato/Lato-Regular.ttf'
LATO_B = f'{FONTS}/sand-box/google/Lato/Lato-Bold.ttf'
MONT = f'{FONTS}/sand-box/google/Montserrat/Montserrat-VariableFont_wght.ttf'
SERIF = f'{FONTS}/liberation/LiberationSerif-Regular.ttf'
SERIF_B = f'{FONTS}/liberation/LiberationSerif-Bold.ttf'
DEJAVU = f'{FONTS}/dejavu/DejaVuSans.ttf'
DEJAVU_B = f'{FONTS}/dejavu/DejaVuSans-Bold.ttf'

W, H = 1050, 600   # 3.5 x 2 in at 300 dpi

CARDS = [
    {
        'file': 'card1_clean.png',
        'desc': 'clean flat scan, left aligned, labelled phones',
        'bg': 'white', 'ink': (25, 35, 60),
        'lines': [
            (60, 50, LATO_B, 50, 'BAYVIEW BEARING SUPPLY, INC.', (180, 30, 40)),
            (60, 150, LATO_B, 40, 'Kevin Smith', None),
            (60, 200, LATO, 30, 'Inside Sales Manager', None),
            (60, 290, LATO, 28, '1234 Industrial Blvd, Suite 200', None),
            (60, 330, LATO, 28, 'Corpus Christi, TX 78405', None),
            (600, 290, LATO, 28, 'Office: (361) 555-0142', None),
            (600, 330, LATO, 28, 'Cell: 361.555.0199', None),
            (600, 370, LATO, 28, 'Fax: 361-555-0143', None),
            (60, 470, LATO, 28, 'kevin.smith@example.com', None),
            (60, 510, LATO, 28, 'www.example.com', None),
        ],
        'truth': {'company': 'BAYVIEW BEARING SUPPLY, INC.', 'name': 'Kevin Smith', 'title': 'Inside Sales Manager',
                  'office': '361-555-0142', 'cell': '361-555-0199', 'fax': '361-555-0143',
                  'email': 'kevin.smith@example.com', 'website': 'www.example.com',
                  'address': '1234 Industrial Blvd, Suite 200', 'city': 'Corpus Christi', 'state': 'TX', 'zip': '78405'},
    },
    {
        'file': 'card2_photo.jpg',
        'desc': 'phone-camera style photo: card on a dark desk, tilted, blurred/noisy, 4032x3024 JPEG '
                'stored sideways (3024x4032 pixels) with EXIF Orientation=6 (needs EXIF rotation + downscale)',
        'bg': (250, 248, 240), 'ink': (30, 30, 30), 'photo': True,
        'lines': [
            (300, 55, MONT, 46, 'LONE STAR GEAR WORKS LLC', (20, 70, 140), True),
            (300, 175, LATO_B, 38, 'Maria L. Torres', None),
            (300, 222, LATO, 30, 'President', None),
            (300, 300, LATO, 27, 'P.O. Box 4471', None),
            (300, 337, LATO, 27, 'Victoria, Texas 77901', None),
            (300, 400, LATO, 27, 'Tel 361-555-0170', None),
            (300, 437, LATO, 27, 'Mobile (361) 555-0188', None),
            (300, 474, LATO, 27, 'Toll Free 1-800-555-0177', None),
            (300, 530, LATO, 27, 'mtorres@example.net', None),
        ],
        'logo': True,
        'truth': {'company': 'LONE STAR GEAR WORKS LLC', 'name': 'Maria L. Torres', 'title': 'President',
                  'office': '361-555-0170', 'cell': '361-555-0188', 'tollfree': '800-555-0177',
                  'email': 'mtorres@example.net', 'address': 'P.O. Box 4471', 'city': 'Victoria', 'state': 'TX', 'zip': '77901'},
    },
    {
        'file': 'card3_dark.png',
        'desc': 'dark card with light text, name and title on one line, P/F phone labels on one line',
        'bg': (18, 38, 74), 'ink': (240, 244, 250),
        'lines': [
            (60, 60, MONT, 44, 'COASTAL HYDRAULIC SERVICES CO.', (255, 196, 60), True),
            (60, 170, DEJAVU_B, 32, 'JAMES R. PATEL  |  Field Service Engineer', None),
            (60, 280, DEJAVU, 26, '880 Port Ave, Ingleside, TX 78362', None),
            (60, 340, DEJAVU, 26, 'P 361-555-0123   F 361-555-0124', None),
            (60, 400, DEJAVU, 26, 'jpatel@example.org', None),
            (60, 450, DEJAVU, 26, 'example.org/service', None),
        ],
        'truth': {'company': 'COASTAL HYDRAULIC SERVICES CO.', 'name': 'JAMES R. PATEL', 'title': 'Field Service Engineer',
                  'office': '361-555-0123', 'fax': '361-555-0124', 'email': 'jpatel@example.org', 'website': 'example.org/service',
                  'address': '880 Port Ave', 'city': 'Ingleside', 'state': 'TX', 'zip': '78362'},
    },
    {
        'file': 'card4_serif.png',
        'desc': 'centered serif layout, company without Inc/LLC, name + title on one line with a comma, extension, ZIP+4',
        'bg': (255, 253, 247), 'ink': (40, 30, 20), 'center': True,
        'lines': [
            (0, 50, SERIF_B, 50, 'Brazos Valley Machine & Tool', (90, 40, 20)),
            (0, 150, SERIF, 36, 'Robert Chen, Purchasing Agent', None),
            (0, 250, SERIF, 28, '2201 FM 1069', None),
            (0, 290, SERIF, 28, 'Aransas Pass TX 78336-1234', None),
            (0, 360, SERIF, 28, 'Phone 361 555 0101 ext. 12', None),
            (0, 400, SERIF, 28, 'rchen@example.com', None),
        ],
        'truth': {'company': 'Brazos Valley Machine & Tool', 'name': 'Robert Chen', 'title': 'Purchasing Agent',
                  'office': '361-555-0101 EXT 12', 'email': 'rchen@example.com',
                  'address': '2201 FM 1069', 'city': 'Aransas Pass', 'state': 'TX', 'zip': '78336-1234'},
    },
]


def render_card(spec):
    img = Image.new('RGB', (W, H), spec['bg'])
    d = ImageDraw.Draw(img)
    if spec.get('logo'):   # simple gear-ish logo block
        cx, cy, r = 150, 140, 80
        for i in range(12):
            a = i * math.pi / 6
            d.rectangle([cx + math.cos(a) * r - 14, cy + math.sin(a) * r - 14, cx + math.cos(a) * r + 14, cy + math.sin(a) * r + 14], fill=(20, 70, 140))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(20, 70, 140))
        d.ellipse([cx - 30, cy - 30, cx + 30, cy + 30], fill=spec['bg'])
    for ln in spec['lines']:
        x, y, fp, size, text, color = ln[:6]
        bold = len(ln) > 6 and ln[6]
        f = font(fp, size, bold)
        if spec.get('center'):
            x = (W - d.textlength(text, font=f)) / 2
        d.text((x, y), text, font=f, fill=color or spec['ink'])
    if spec.get('center'):
        d.line([(W / 2 - 160, 128), (W / 2 + 160, 128)], fill=(90, 40, 20), width=2)
    return img


def photo_effect(card):
    """Put the card on a desk, tilt it, add blur/noise and shading like a phone photo."""
    random.seed(7)
    PW, PH = 4032, 3024               # landscape as the sensor sees it
    desk = Image.new('RGB', (PW, PH), (70, 58, 48))
    dd = ImageDraw.Draw(desk)
    for i in range(0, PH, 6):          # wood-ish streaks
        c = 62 + int(10 * math.sin(i / 37.0)) + random.randint(-4, 4)
        dd.line([(0, i), (PW, i + random.randint(-20, 20))], fill=(c + 8, c, c - 8), width=6)
    big = card.resize((W * 3, H * 3), Image.LANCZOS).convert('RGBA')
    big = big.rotate(3.5, expand=True, resample=Image.BICUBIC)
    shadow = Image.new('RGBA', big.size, (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 110), mask=big.split()[3])
    shadow = shadow.filter(ImageFilter.GaussianBlur(25))
    ox, oy = (PW - big.width) // 2, (PH - big.height) // 2
    desk.paste(shadow, (ox + 30, oy + 40), shadow)
    desk.paste(big, (ox, oy), big)
    # uneven lighting
    grad = Image.linear_gradient('L').resize((PW, PH)).rotate(35, expand=False)
    desk = Image.composite(desk, Image.blend(desk, Image.new('RGB', desk.size, (0, 0, 0)), 0.35), grad.point(lambda v: 120 + v // 2))
    desk = desk.filter(ImageFilter.GaussianBlur(1.6))
    noise = Image.effect_noise((PW, PH), 18).convert('RGB')
    desk = Image.blend(desk, noise, 0.06)
    return desk


def main():
    os.makedirs(OUT, exist_ok=True)
    truth = {}
    for spec in CARDS:
        img = render_card(spec)
        path = os.path.join(OUT, spec['file'])
        if spec.get('photo'):
            photo = photo_effect(img)
            # Store the pixels sideways, as a phone sensor does when the photo was taken with the phone turned,
            # and record EXIF Orientation=6 ("rotate 90 deg clockwise to display"). Without EXIF handling the
            # card reads sideways; with it, the card is upright.
            stored = photo.transpose(Image.ROTATE_90)            # 90 deg counter-clockwise -> 3024x4032 pixels
            exif = Image.Exif(); exif[0x0112] = 6
            stored.save(path, 'JPEG', quality=86, exif=exif.tobytes())
        else:
            img.save(path)
        truth[spec['file']] = {'desc': spec['desc'], 'expected': spec['truth'],
                               'text': '\n'.join(l[4] for l in spec['lines'])}
        print('wrote', path, os.path.getsize(path), 'bytes')
    # stress test: low-resolution, blurry, heavily compressed photo of card 1 (no EXIF)
    card1 = render_card(CARDS[0])
    small = photo_effect(card1).resize((1200, 900), Image.LANCZOS).filter(ImageFilter.GaussianBlur(1.1))
    path = os.path.join(OUT, 'card5_lowres_photo.jpg'); small.save(path, 'JPEG', quality=55)
    truth['card5_lowres_photo.jpg'] = {'desc': 'stress test: 1200x900 blurry, JPEG q55 photo of card 1 (card text ~12 px high)',
                                       'expected': CARDS[0]['truth'], 'text': truth['card1_clean.png']['text'], 'stress': True}
    print('wrote', path, os.path.getsize(path), 'bytes')
    with open(os.path.join(OUT, 'truth.json'), 'w') as fh:
        json.dump(truth, fh, indent=1)


if __name__ == '__main__':
    main()
