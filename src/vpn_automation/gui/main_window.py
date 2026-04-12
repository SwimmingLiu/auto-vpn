import queue
import subprocess
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from PIL import ImageTk

from vpn_automation.app import build_app_metadata
from vpn_automation.config.store import ProfileStore
from vpn_automation.integrations.packaging import package_application
from vpn_automation.gui.preview import render_status_preview
from vpn_automation.gui.viewmodel import apply_form_state_to_profile, profile_to_form_state
from vpn_automation.pipeline.controller import PipelineController, PipelineSummary


class AutomationMainWindow:
    def __init__(
        self,
        *,
        project_root: Path,
        store: ProfileStore,
        controller: PipelineController,
    ) -> None:
        self.project_root = project_root
        self.store = store
        self.controller = controller
        self.profile = self.store.load_or_create(project_root)
        self.queue: queue.Queue[tuple] = queue.Queue()
        self.worker: threading.Thread | None = None
        self.preview_image = None

        metadata = build_app_metadata()
        self.root = tk.Tk()
        self.root.title(metadata["name"])
        self.root.geometry("1440x920")

        self.string_vars: dict[str, tk.StringVar] = {}
        self.bool_vars: dict[str, tk.BooleanVar] = {}
        self.stage_items: dict[str, str] = {}
        self.last_artifact_dir = ""

        self._build_layout()
        self._load_profile_into_form()
        self.root.after(150, self._process_queue)

    def _build_layout(self) -> None:
        container = ttk.PanedWindow(self.root, orient=tk.HORIZONTAL)
        container.pack(fill=tk.BOTH, expand=True)

        left = ttk.Frame(container, padding=12)
        right = ttk.Frame(container, padding=12)
        container.add(left, weight=3)
        container.add(right, weight=2)

        notebook = ttk.Notebook(left)
        notebook.pack(fill=tk.BOTH, expand=True)

        sources_tab = ttk.Frame(notebook, padding=12)
        settings_tab = ttk.Frame(notebook, padding=12)
        notebook.add(sources_tab, text="Sources")
        notebook.add(settings_tab, text="Settings")

        self._build_sources_tab(sources_tab)
        self._build_settings_tab(settings_tab)
        self._build_run_panel(right)

    def _build_sources_tab(self, parent: ttk.Frame) -> None:
        ttk.Label(parent, text="VPN source configuration", font=("", 13, "bold")).grid(
            row=0, column=0, columnspan=4, sticky="w", pady=(0, 12)
        )
        for column, title in enumerate(["Enabled", "Source", "Capture URL", "Key"]):
            ttk.Label(parent, text=title).grid(row=1, column=column, sticky="w", padx=4, pady=4)

        for row_index, source_name in enumerate(self.profile.sources.keys(), start=2):
            enabled_var = tk.BooleanVar(value=True)
            url_var = tk.StringVar()
            key_var = tk.StringVar()
            self.bool_vars[f"source.{source_name}.enabled"] = enabled_var
            self.string_vars[f"source.{source_name}.url"] = url_var
            self.string_vars[f"source.{source_name}.key"] = key_var

            ttk.Checkbutton(parent, variable=enabled_var).grid(row=row_index, column=0, sticky="w", padx=4, pady=4)
            ttk.Label(parent, text=source_name).grid(row=row_index, column=1, sticky="w", padx=4, pady=4)
            ttk.Entry(parent, textvariable=url_var, width=72).grid(row=row_index, column=2, sticky="ew", padx=4, pady=4)
            ttk.Entry(parent, textvariable=key_var, width=28).grid(row=row_index, column=3, sticky="ew", padx=4, pady=4)

        parent.columnconfigure(2, weight=1)

    def _build_settings_tab(self, parent: ttk.Frame) -> None:
        fields = [
            ("speed.min_download_mb_s", "Min download MB/s"),
            ("speed.timeout_seconds", "Timeout seconds"),
            ("speed.concurrency", "Speedtest concurrency"),
            ("deploy.project_name", "Pages project name"),
            ("deploy.pages_project_url", "Pages secret endpoint base URL"),
            ("deploy.subscription_url", "Final subscription verification URL"),
        ]
        ttk.Label(parent, text="Pipeline and deploy settings", font=("", 13, "bold")).grid(
            row=0, column=0, columnspan=2, sticky="w", pady=(0, 12)
        )
        for row_index, (key, label) in enumerate(fields, start=1):
            self.string_vars.setdefault(key, tk.StringVar())
            ttk.Label(parent, text=label).grid(row=row_index, column=0, sticky="w", padx=4, pady=6)
            ttk.Entry(parent, textvariable=self.string_vars[key], width=88).grid(
                row=row_index,
                column=1,
                sticky="ew",
                padx=4,
                pady=6,
            )

        self.string_vars.setdefault("speed.urls", tk.StringVar())
        ttk.Label(parent, text="Speedtest URLs (one per line)").grid(
            row=len(fields) + 1, column=0, sticky="nw", padx=4, pady=6
        )
        self.urls_text = tk.Text(parent, width=88, height=8, wrap="word")
        self.urls_text.grid(row=len(fields) + 1, column=1, sticky="nsew", padx=4, pady=6)
        parent.columnconfigure(1, weight=1)
        parent.rowconfigure(len(fields) + 1, weight=1)

    def _build_run_panel(self, parent: ttk.Frame) -> None:
        button_row = ttk.Frame(parent)
        button_row.pack(fill=tk.X, pady=(0, 12))
        ttk.Button(button_row, text="Reload", command=self.reload_profile).pack(side=tk.LEFT, padx=4)
        ttk.Button(button_row, text="Save", command=self.save_profile).pack(side=tk.LEFT, padx=4)
        self.run_button = ttk.Button(button_row, text="Run full pipeline", command=self.run_pipeline)
        self.run_button.pack(side=tk.LEFT, padx=4)
        self.package_button = ttk.Button(button_row, text="Package app", command=self.package_app)
        self.package_button.pack(side=tk.LEFT, padx=4)
        ttk.Button(button_row, text="Open artifacts", command=self.open_artifacts_folder).pack(side=tk.LEFT, padx=4)

        ttk.Label(parent, text="Stage status", font=("", 13, "bold")).pack(anchor="w")
        self.stage_tree = ttk.Treeview(parent, columns=("status",), show="headings", height=9)
        self.stage_tree.heading("status", text="Status")
        self.stage_tree.column("status", width=120, anchor="center")
        self.stage_tree.pack(fill=tk.X, pady=(6, 12))
        for stage in self.controller.stage_names():
            item_id = self.stage_tree.insert("", tk.END, values=(f"{stage}: pending",))
            self.stage_items[stage] = item_id

        ttk.Label(parent, text="Preview", font=("", 13, "bold")).pack(anchor="w")
        self.preview_label = ttk.Label(parent)
        self.preview_label.pack(fill=tk.X, pady=(6, 12))
        self._update_preview()

        ttk.Label(parent, text="Logs", font=("", 13, "bold")).pack(anchor="w")
        log_frame = ttk.Frame(parent)
        log_frame.pack(fill=tk.BOTH, expand=True)
        self.log_text = tk.Text(log_frame, height=18, wrap="word")
        scroll = ttk.Scrollbar(log_frame, orient=tk.VERTICAL, command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=scroll.set)
        self.log_text.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scroll.pack(side=tk.RIGHT, fill=tk.Y)

    def _load_profile_into_form(self) -> None:
        state = profile_to_form_state(self.profile)
        for key, value in state.items():
            if key.endswith(".enabled"):
                self.bool_vars[key].set(value == "1")
            else:
                self.string_vars[key].set(value)
        self.urls_text.delete("1.0", tk.END)
        self.urls_text.insert("1.0", state.get("speed.urls", ""))

    def _collect_form_state(self) -> dict[str, str]:
        state = {key: var.get() for key, var in self.string_vars.items()}
        for key, var in self.bool_vars.items():
            state[key] = "1" if var.get() else "0"
        state["speed.urls"] = self.urls_text.get("1.0", tk.END).strip()
        return state

    def reload_profile(self) -> None:
        self.profile = self.store.load_or_create(self.project_root)
        self._load_profile_into_form()
        self._append_log("[ui] profile reloaded")

    def save_profile(self) -> None:
        self.profile = apply_form_state_to_profile(self.profile, self._collect_form_state())
        self.store.save(self.profile)
        self._append_log("[ui] profile saved")

    def run_pipeline(self) -> None:
        if self.worker and self.worker.is_alive():
            return
        self.save_profile()
        self.run_button.state(["disabled"])
        self._append_log("[ui] pipeline started")
        self.worker = threading.Thread(target=self._run_pipeline_worker, daemon=True)
        self.worker.start()

    def _run_pipeline_worker(self) -> None:
        try:
            summary = self.controller.run(
                self.profile,
                log_callback=lambda message: self.queue.put(("log", message)),
                stage_callback=lambda stage, status: self.queue.put(("stage", stage, status)),
            )
            self.queue.put(("done", summary))
        except Exception as exc:
            self.queue.put(("error", str(exc)))

    def package_app(self) -> None:
        if self.worker and self.worker.is_alive():
            return
        self.package_button.state(["disabled"])
        self._append_log("[ui] packaging started")
        self.worker = threading.Thread(target=self._run_package_worker, daemon=True)
        self.worker.start()

    def _run_package_worker(self) -> None:
        try:
            result = package_application(self.project_root)
            self.queue.put(("packaged", result))
        except Exception as exc:
            self.queue.put(("error", str(exc)))

    def _process_queue(self) -> None:
        while True:
            try:
                event = self.queue.get_nowait()
            except queue.Empty:
                break

            kind = event[0]
            if kind == "log":
                self._append_log(event[1])
            elif kind == "stage":
                self._set_stage_status(event[1], event[2])
            elif kind == "done":
                self._handle_summary(event[1])
            elif kind == "packaged":
                self.package_button.state(["!disabled"])
                self._append_log("[done] application packaged under dist/")
                messagebox.showinfo("Packaging completed", "Application packaged under the dist/ directory.")
            elif kind == "error":
                self.run_button.state(["!disabled"])
                self.package_button.state(["!disabled"])
                self._append_log(f"[error] {event[1]}")
                messagebox.showerror("Pipeline failed", event[1])

        self.root.after(150, self._process_queue)

    def _set_stage_status(self, stage: str, status: str) -> None:
        item_id = self.stage_items[stage]
        self.stage_tree.item(item_id, values=(f"{stage}: {status}",))
        self._update_preview()

    def _handle_summary(self, summary: PipelineSummary) -> None:
        self.run_button.state(["!disabled"])
        self.last_artifact_dir = summary.artifact_dir
        for stage, status in summary.stage_status.items():
            self._set_stage_status(stage, status)
        self._update_preview(summary)
        self._append_log(f"[done] artifacts: {summary.artifact_dir}")
        messagebox.showinfo("Pipeline completed", f"Artifacts saved to:\n{summary.artifact_dir}")

    def _update_preview(self, summary: PipelineSummary | None = None) -> None:
        stage_status = (
            summary.stage_status
            if summary
            else {stage: "pending" for stage in self.controller.stage_names()}
        )
        counts = summary.counts if summary else {}
        image = render_status_preview(
            app_name=build_app_metadata()["name"],
            stage_status=stage_status,
            counts=counts,
        )
        self.preview_image = ImageTk.PhotoImage(image)
        self.preview_label.configure(image=self.preview_image)

    def _append_log(self, message: str) -> None:
        self.log_text.insert(tk.END, message + "\n")
        self.log_text.see(tk.END)

    def open_artifacts_folder(self) -> None:
        target = self.last_artifact_dir or self.profile.workspace.artifacts_root
        if not target:
            return
        subprocess.Popen(["open", target])


def create_main_window(
    *,
    project_root: Path,
    store: ProfileStore,
    controller: PipelineController,
) -> AutomationMainWindow:
    return AutomationMainWindow(project_root=project_root, store=store, controller=controller)
