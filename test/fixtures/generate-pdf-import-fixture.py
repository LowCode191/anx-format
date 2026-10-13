#!/usr/bin/env python3
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


OUTPUT = Path(__file__).with_name("pdf-import-fixture.pdf")


def build_fixture() -> None:
    styles = getSampleStyleSheet()
    document = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=letter,
        rightMargin=0.7 * inch,
        leftMargin=0.7 * inch,
        topMargin=0.65 * inch,
        bottomMargin=0.65 * inch,
        title="ANDoc PDF Import Fixture",
        author="ANDoc",
    )

    story = [
        Paragraph("ANDoc PDF Import Fixture", styles["Title"]),
        Spacer(1, 0.16 * inch),
        Paragraph(
            "This document tests local PDF conversion into a single machine-readable ANDoc package. "
            "The importer should preserve page provenance, headings, paragraphs, and semantic tables.",
            styles["BodyText"],
        ),
        Spacer(1, 0.2 * inch),
        Paragraph("Conversion Results", styles["Heading2"]),
        Spacer(1, 0.08 * inch),
        Table(
            [
                ["Surface", "Representation", "Editable"],
                ["Human", "Rendered document", "Yes"],
                ["Agent", "Typed blocks and transactions", "Yes"],
                ["Export", "PDF projection", "Re-import required"],
            ],
            colWidths=[1.15 * inch, 2.65 * inch, 1.55 * inch],
            style=TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#155e75")),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                    ("GRID", (0, 0), (-1, -1), 0.6, colors.HexColor("#71717a")),
                    ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#f4f4f5")),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("TOPPADDING", (0, 0), (-1, -1), 7),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                ]
            ),
        ),
        Spacer(1, 0.3 * inch),
        Paragraph("Agent Experience", styles["Heading2"]),
        Paragraph(
            "An agent should address a stable block ID rather than guessing a page coordinate. "
            "Every imported block should point back to its source page and bounding box when available.",
            styles["BodyText"],
        ),
        PageBreak(),
        Paragraph("Second Page", styles["Title"]),
        Spacer(1, 0.16 * inch),
        Paragraph("Revision Safety", styles["Heading2"]),
        Paragraph(
            "Human and agent edits use the same revision-checked transaction stream. A stale edit must fail before mutation.",
            styles["BodyText"],
        ),
        Spacer(1, 0.18 * inch),
        Paragraph("Original Source", styles["Heading2"]),
        Paragraph(
            "The source PDF remains embedded in the ANDoc package under sources so an agent can audit or reprocess it later.",
            styles["BodyText"],
        ),
    ]
    document.build(story)


if __name__ == "__main__":
    build_fixture()
    print(OUTPUT)
