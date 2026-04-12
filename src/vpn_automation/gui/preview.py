from PIL import Image, ImageDraw, ImageFont


def render_status_preview(
    *,
    app_name: str,
    stage_status: dict[str, str],
    counts: dict[str, int],
) -> Image.Image:
    image = Image.new("RGB", (520, 240), color="#f5f7fb")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default()

    draw.rounded_rectangle((16, 16, 504, 224), radius=18, fill="#ffffff", outline="#d8deea")
    draw.rounded_rectangle((32, 32, 488, 76), radius=12, fill="#2f6fed")
    draw.text((48, 46), app_name, fill="#ffffff", font=font)

    draw.text((40, 94), "Pipeline stages", fill="#1b2430", font=font)
    y = 118
    for name, status in stage_status.items():
        fill = {"success": "#22c55e", "running": "#f59e0b", "pending": "#94a3b8"}.get(status, "#ef4444")
        draw.text((44, y), name, fill="#334155", font=font)
        draw.rounded_rectangle((150, y - 2, 240, y + 14), radius=8, fill=fill)
        draw.text((164, y + 1), status.upper(), fill="#ffffff", font=font)
        y += 26

    draw.text((290, 94), "Artifacts", fill="#1b2430", font=font)
    metrics_y = 118
    for key, value in counts.items():
        draw.text((294, metrics_y), f"{key}: {value}", fill="#334155", font=font)
        metrics_y += 24

    return image
