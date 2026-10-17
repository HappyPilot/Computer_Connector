"""Produce a small ChatGPT plugin-upload icon from the approved WCM PNG.

Requires Pillow in the maintainer's Python environment. Never generates new art:
it only scales and optimizes the already-approved PNG.
"""

from io import BytesIO
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "wcm-icon.png"
TARGET = ROOT / "assets" / "wcm-plugin-icon.png"
MAX_BYTES = 9_000  # Reserve margin below ChatGPT's 10 KB upload limit.


def main():
    with Image.open(SOURCE) as raw:
        source = raw.convert("RGBA")
    assert source.width == source.height, "Source must be square"

    # Prefer resolution, then color fidelity; use palette PNG to preserve alpha.
    for pixels in (128, 112, 96, 80, 64):
        scaled = source.resize((pixels, pixels), Image.Resampling.LANCZOS)
        for colors in (256, 192, 128, 96, 64, 48, 32):
            paletted = scaled.quantize(
                colors=colors,
                method=Image.Quantize.FASTOCTREE,
                dither=Image.Dither.NONE,
            )
            stream = BytesIO()
            paletted.save(stream, format="PNG", optimize=True, compress_level=9)
            data = stream.getvalue()
            if len(data) <= MAX_BYTES:
                TARGET.write_bytes(data)
                with Image.open(TARGET) as icon:
                    assert icon.size == (pixels, pixels)
                    assert icon.getpixel((0, 0)) is not None
                    assert icon.convert("RGBA").getpixel((0, 0))[3] == 0
                print(f"Plugin upload icon: {TARGET} ({pixels}x{pixels}, {len(data)} bytes)")
                return
    raise RuntimeError("Could not meet the plugin icon upload size limit")


if __name__ == "__main__":
    main()
