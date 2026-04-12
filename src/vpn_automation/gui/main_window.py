import tkinter as tk
from tkinter import ttk

from vpn_automation.app import build_app_metadata
from vpn_automation.pipeline.controller import PipelineController


def create_main_window() -> tk.Tk:
    metadata = build_app_metadata()
    window = tk.Tk()
    window.title(metadata["name"])
    ttk.Label(window, text="VPN Subscription Automation").pack(padx=12, pady=12)
    ttk.Label(window, text="Stages: " + ", ".join(PipelineController().stage_names())).pack(
        padx=12,
        pady=12,
    )
    return window
