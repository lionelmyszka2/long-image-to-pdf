#!/usr/bin/env python3
"""
Convert a very tall image, such as a full-page website screenshot, into a
readable multi-page PDF.

The script keeps the image at page width, then slices it vertically into A4
pages. Split points are nudged toward visually quiet horizontal bands so the
PDF is less likely to cut through text.
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageOps


PAGE_SIZES_IN = {
    "a4": (8.27, 11.69),
    "letter": (8.5, 11.0),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Transform a long image into a readable paginated PDF."
    )
    parser.add_argument("input", type=Path, help="Input image: PNG, JPG, WEBP, etc.")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="Output PDF path. Defaults to <input>-paginated.pdf",
    )
    parser.add_argument(
        "--page-size",
        choices=sorted(PAGE_SIZES_IN),
        default="a4",
        help="PDF page format. Default: a4",
    )
    parser.add_argument(
        "--margin",
        type=float,
        default=0.35,
        help="Page margin in inches. Default: 0.35",
    )
    parser.add_argument(
        "--dpi",
        type=int,
        default=200,
        help="Raster resolution used for the generated PDF pages. Default: 200",
    )
    parser.add_argument(
        "--search-window",
        type=float,
        default=0.18,
        help=(
            "Fraction of a page slice searched before/after the ideal cut "
            "for a quieter split line. Default: 0.18"
        ),
    )
    parser.add_argument(
        "--overlap",
        type=int,
        default=0,
        help="Optional overlap between pages, in source-image pixels. Default: 0",
    )
    return parser.parse_args()


def flatten_image(path: Path) -> Image.Image:
    image = Image.open(path)
    image = ImageOps.exif_transpose(image)

    if image.mode in ("RGBA", "LA") or (
        image.mode == "P" and "transparency" in image.info
    ):
        background = Image.new("RGBA", image.size, "white")
        background.alpha_composite(image.convert("RGBA"))
        return background.convert("RGB")

    return image.convert("RGB")


def quiet_row_scores(image: Image.Image) -> list[int]:
    """Return one grayscale mean value per row; higher means closer to white."""
    grayscale = image.convert("L")
    one_pixel_wide = grayscale.resize((1, image.height), Image.Resampling.BOX)
    return list(one_pixel_wide.getdata())


def choose_split(
    scores: list[int],
    start: int,
    ideal_end: int,
    source_height: int,
    search_window: int,
) -> int:
    lower = max(start + 200, ideal_end - search_window)
    upper = min(source_height - 1, ideal_end + search_window)

    if lower >= upper:
        return min(ideal_end, source_height)

    best_row = ideal_end
    best_value = -1.0
    for row in range(lower, upper + 1):
        band_start = max(0, row - 4)
        band_end = min(source_height, row + 5)
        whiteness = sum(scores[band_start:band_end]) / (band_end - band_start)
        distance_penalty = abs(row - ideal_end) / max(1, search_window)
        value = whiteness - (distance_penalty * 12)
        if value > best_value:
            best_value = value
            best_row = row

    return best_row


def split_ranges(
    image: Image.Image,
    slice_height: int,
    search_window: int,
    overlap: int,
) -> Iterable[tuple[int, int]]:
    scores = quiet_row_scores(image)
    source_height = image.height
    start = 0

    while start < source_height:
        ideal_end = min(source_height, start + slice_height)
        if ideal_end >= source_height:
            yield start, source_height
            break

        end = choose_split(scores, start, ideal_end, source_height, search_window)
        if end <= start:
            end = ideal_end

        yield start, end
        start = max(0, end - overlap)


def create_pdf_pages(
    image: Image.Image,
    ranges: Iterable[tuple[int, int]],
    page_width_px: int,
    page_height_px: int,
    margin_px: int,
) -> list[Image.Image]:
    content_width_px = page_width_px - (2 * margin_px)
    pages: list[Image.Image] = []

    for start, end in ranges:
        crop = image.crop((0, start, image.width, end))
        rendered_height = max(1, round(crop.height * (content_width_px / image.width)))
        rendered = crop.resize(
            (content_width_px, rendered_height), Image.Resampling.LANCZOS
        )

        page = Image.new("RGB", (page_width_px, page_height_px), "white")
        page.paste(rendered, (margin_px, margin_px))
        pages.append(page)

    return pages


def main() -> None:
    args = parse_args()
    input_path = args.input.expanduser().resolve()
    output_path = (
        args.output.expanduser().resolve()
        if args.output
        else input_path.with_name(f"{input_path.stem}-paginated.pdf")
    )

    if args.margin < 0:
        raise SystemExit("--margin must be positive")
    if args.dpi < 72:
        raise SystemExit("--dpi must be at least 72")

    image = flatten_image(input_path)

    page_width_in, page_height_in = PAGE_SIZES_IN[args.page_size]
    page_width_px = round(page_width_in * args.dpi)
    page_height_px = round(page_height_in * args.dpi)
    margin_px = round(args.margin * args.dpi)
    content_width_px = page_width_px - (2 * margin_px)
    content_height_px = page_height_px - (2 * margin_px)

    if content_width_px <= 0 or content_height_px <= 0:
        raise SystemExit("The margin is too large for the selected page size.")

    scale = content_width_px / image.width
    slice_height = math.floor(content_height_px / scale)
    search_window = max(0, round(slice_height * args.search_window))

    pages = create_pdf_pages(
        image=image,
        ranges=split_ranges(
            image=image,
            slice_height=slice_height,
            search_window=search_window,
            overlap=max(0, args.overlap),
        ),
        page_width_px=page_width_px,
        page_height_px=page_height_px,
        margin_px=margin_px,
    )

    if not pages:
        raise SystemExit("No page could be generated.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    pages[0].save(
        output_path,
        "PDF",
        save_all=True,
        append_images=pages[1:],
        resolution=args.dpi,
    )

    print(f"Created {output_path}")
    print(f"Source image: {image.width} x {image.height}px")
    print(f"PDF pages: {len(pages)}")


if __name__ == "__main__":
    main()
