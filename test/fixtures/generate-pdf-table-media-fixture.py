#!/usr/bin/env python3
from pathlib import Path
import subprocess
import sys

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Image, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


ROOT = Path(__file__).parent
OUTPUT = ROOT / "pdf-table-media-fixture.pdf"
PHOTO = ROOT / "pdf-media-photo.png"
CHART = ROOT / "pdf-media-chart.png"


def ensure_visuals() -> None:
    if PHOTO.exists() and CHART.exists():
        return
    subprocess.run([sys.executable, str(ROOT / "generate-pdf-media-fixture.py")], check=True)


def build_fixture() -> None:
    ensure_visuals()
    styles = getSampleStyleSheet()
    document = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=letter,
        rightMargin=0.7 * inch,
        leftMargin=0.7 * inch,
        topMargin=0.55 * inch,
        bottomMargin=0.55 * inch,
        title="ANDoc Table And Media Editing Fixture",
        author="ANDoc",
    )
    operations = Table(
        [
            ["Metric", "Baseline", "Review status"],
            ["Availability", "96.2%", "Pending"],
            ["Net output", "412 MW", "Pending"],
            ["Heat rate", "10,420 Btu/kWh", "Pending"],
        ],
        colWidths=[2.2 * inch, 1.8 * inch, 2.2 * inch],
        repeatRows=1,
    )
    operations.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#155e75")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
        ("GRID", (0, 0), (-1, -1), 0.75, colors.HexColor("#52525b")),
        ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#f4f4f5")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f4f4f5")]),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ]))
    story = [
        Paragraph("ANDoc Table And Media Editing Fixture", styles["Title"]),
        Spacer(1, 0.12 * inch),
        Paragraph(
            "This controlled source proves that an agent can update one semantic table cell while a human updates media metadata in the same canonical document.",
            styles["BodyText"],
        ),
        Spacer(1, 0.18 * inch),
        Paragraph("Site Image", styles["Heading2"]),
        Image(str(PHOTO), width=6.5 * inch, height=3.03 * inch),
        Paragraph("Figure 1. North Ridge wind generation site before human metadata review.", styles["Italic"]),
        PageBreak(),
        Paragraph("Generation Chart", styles["Heading2"]),
        Image(str(CHART), width=6.5 * inch, height=3.47 * inch),
        Paragraph("Figure 2. Bar chart of monthly net generation in MWh.", styles["Italic"]),
        Spacer(1, 0.16 * inch),
        Paragraph(
            "The chart retains a visual fallback and a truthful structured-data extraction status.",
            styles["BodyText"],
        ),
        PageBreak(),
        Paragraph("Operations Review Table", styles["Heading2"]),
        Paragraph(
            "Each cell must have a stable machine address so an agent can update a single value without replacing the table.",
            styles["BodyText"],
        ),
        Spacer(1, 0.2 * inch),
        operations,
        Spacer(1, 0.18 * inch),
        Paragraph("Table 1. Controlled operating metrics for targeted editing.", styles["Italic"]),
    ]
    document.build(story)


if __name__ == "__main__":
    build_fixture()
    print(OUTPUT)
