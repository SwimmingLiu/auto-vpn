import hashlib

from vpn_automation.gui.preview import render_status_preview


def test_render_status_preview_matches_expected_visual_hash() -> None:
    image = render_status_preview(
        app_name="vpn-subscription-automation",
        stage_status={"doctor": "success", "extract": "success", "deploy": "running"},
        counts={"raw_links": 12, "postprocess_links": 5},
    )

    digest = hashlib.sha256(image.tobytes()).hexdigest()

    assert digest == "4a07bd979013eb238fe111e5b54b571b512dc033a6fb7ee8a1e81ae6d5a8b028"
