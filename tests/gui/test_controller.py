from vpn_automation.pipeline.controller import PipelineController


def test_pipeline_controller_exposes_named_stages() -> None:
    controller = PipelineController()
    assert controller.stage_names()[0] == "doctor"
    assert "deploy" in controller.stage_names()
