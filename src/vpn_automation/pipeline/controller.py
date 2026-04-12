class PipelineController:
    def stage_names(self) -> list[str]:
        return [
            "doctor",
            "extract",
            "dedupe",
            "speedtest",
            "postprocess",
            "render",
            "obfuscate",
            "deploy",
            "verify",
        ]
