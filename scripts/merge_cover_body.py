"""
Merge cover PDF (page 1) with body PDF (pages 2+) into the final deliverable.
Output: /home/z/my-project/download/design-systems-agentic-workflows.pdf
"""
from pypdf import PdfReader, PdfWriter

A4_W, A4_H = 595.28, 841.89  # A4 in points


def normalize_page_to_a4(page):
    """Scale every page to exact A4 dimensions to guarantee uniform size."""
    box = page.mediabox
    w, h = float(box.width), float(box.height)
    if abs(w - A4_W) > 0.1 or abs(h - A4_H) > 0.1:
        page.scale_to(A4_W, A4_H)
    return page


def insert_cover(cover_pdf, body_pdf, output_pdf):
    writer = PdfWriter()
    # Cover as page 1
    cover_page = PdfReader(cover_pdf).pages[0]
    writer.add_page(normalize_page_to_a4(cover_page))
    # Body pages follow
    for page in PdfReader(body_pdf).pages:
        writer.add_page(normalize_page_to_a4(page))
    writer.add_metadata({
        '/Title': 'Design Systems for Agentic Workflows',
        '/Author': 'Z.ai',
        '/Creator': 'Z.ai',
        '/Subject': 'Engineering Strategy Memo - Design System Registry for Agentic UI Generation',
    })
    with open(output_pdf, 'wb') as f:
        writer.write(f)


if __name__ == '__main__':
    cover = '/home/z/my-project/download/_cover.pdf'
    body = '/home/z/my-project/download/_body.pdf'
    out = '/home/z/my-project/download/design-systems-agentic-workflows.pdf'
    insert_cover(cover, body, out)
    print(f'Merged: {out}')
    print(f'Pages: {len(PdfReader(out).pages)}')
    import os
    print(f'Size: {os.path.getsize(out)/1024:.1f} KB')
