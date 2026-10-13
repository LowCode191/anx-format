#!/usr/bin/env python3
from pathlib import Path

from PIL import Image as PillowImage
from PIL import ImageDraw, ImageFont
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Image, PageBreak, Paragraph, SimpleDocTemplate, Spacer


ROOT = Path(__file__).parent
OUTPUT = ROOT / "pdf-media-fixture.pdf"
PHOTO = ROOT / "pdf-media-photo.png"
CHART = ROOT / "pdf-media-chart.png"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    names = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def build_photo() -> None:
    image = PillowImage.new("RGB", (900, 420), "#071827")
    draw = ImageDraw.Draw(image)
    for y in range(420):
        ratio = y / 419
        draw.line((0, y, 900, y), fill=(7 + int(13 * ratio), 24 + int(34 * ratio), 39 + int(45 * ratio)))
    draw.ellipse((660, 42, 758, 140), fill="#fbbf24")
    draw.polygon([(0, 330), (170, 190), (300, 330)], fill="#164e63")
    draw.polygon([(190, 330), (410, 150), (620, 330)], fill="#155e75")
    draw.polygon([(510, 330), (710, 205), (900, 330)], fill="#0e7490")
    draw.rectangle((0, 330, 900, 420), fill="#083344")
    for x in (205, 448, 705):
        draw.line((x, 182, x, 350), fill="#e2e8f0", width=7)
        draw.ellipse((x - 11, 170, x + 11, 192), fill="#f8fafc")
        draw.line((x, 181, x - 70, 132), fill="#f8fafc", width=6)
        draw.line((x, 181, x + 75, 143), fill="#f8fafc", width=6)
        draw.line((x, 181, x - 6, 264), fill="#f8fafc", width=6)
    draw.rounded_rectangle((34, 28, 400, 105), radius=16, fill="#082f49", outline="#22d3ee", width=2)
    draw.text((58, 45), "North Ridge Wind Site", font=font(30, bold=True), fill="#ecfeff")
    image.save(PHOTO, format="PNG", optimize=False)


def build_chart() -> None:
    image = PillowImage.new("RGB", (900, 480), "white")
    draw = ImageDraw.Draw(image)
    draw.text((48, 24), "Monthly Generation", font=font(34, bold=True), fill="#18181b")
    draw.text((48, 70), "Net MWh by month", font=font(21), fill="#52525b")
    left, top, right, bottom = 95, 125, 850, 398
    draw.line((left, top, left, bottom), fill="#52525b", width=3)
    draw.line((left, bottom, right, bottom), fill="#52525b", width=3)
    for value in range(0, 101, 25):
        y = bottom - int((value / 100) * (bottom - top))
        draw.line((left, y, right, y), fill="#e4e4e7", width=2)
        draw.text((42, y - 12), str(value), font=font(17), fill="#52525b")
    values = [("Jan", 42), ("Feb", 58), ("Mar", 73), ("Apr", 86), ("May", 78)]
    width = 92
    gap = 48
    for index, (label, value) in enumerate(values):
        x = left + 54 + index * (width + gap)
        y = bottom - int((value / 100) * (bottom - top))
        draw.rounded_rectangle((x, y, x + width, bottom), radius=7, fill="#0891b2")
        draw.text((x + 25, y - 30), str(value), font=font(18, bold=True), fill="#155e75")
        draw.text((x + 25, bottom + 13), label, font=font(19), fill="#27272a")
    image.save(CHART, format="PNG", optimize=False)


def build_fixture() -> None:
    build_photo()
    build_chart()
    styles = getSampleStyleSheet()
    document = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=letter,
        rightMargin=0.7 * inch,
        leftMargin=0.7 * inch,
        topMargin=0.55 * inch,
        bottomMargin=0.55 * inch,
        title="ANDoc PDF Media Fixture",
        author="ANDoc",
    )
    story = [
        Paragraph("ANDoc PDF Media Fixture", styles["Title"]),
        Spacer(1, 0.12 * inch),
        Paragraph(
            "This controlled source tests native image assets, chart fallbacks, structured chart data, and transaction-backed editing.",
            styles["BodyText"],
        ),
        Spacer(1, 0.18 * inch),
        Paragraph("Site Image", styles["Heading2"]),
        Image(str(PHOTO), width=6.5 * inch, height=3.03 * inch),
        Paragraph("Figure 1. North Ridge wind generation site.", styles["Italic"]),
        PageBreak(),
        Paragraph("Generation Chart", styles["Heading2"]),
        Image(str(CHART), width=6.5 * inch, height=3.47 * inch),
        Paragraph("Figure 2. Monthly net generation in MWh.", styles["Italic"]),
        Spacer(1, 0.16 * inch),
        Paragraph(
            "An ANDoc chart keeps a machine-readable specification when extraction succeeds and always retains a visual fallback asset.",
            styles["BodyText"],
        ),
    ]
    document.build(story)


if __name__ == "__main__":
    build_fixture()
    print(OUTPUT)
