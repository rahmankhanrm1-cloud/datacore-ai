const el = id => document.getElementById(id);
let toolMode = "auto";
let activeProject = null;
let pendingPdf = null;
let pendingPdfUrl = null;
const pdfUrls = new Set();
let mediaRecorder = null;

function updateChatModelVisibility() {
  el("chatModel").hidden = !config?.nemotron_enabled || toolMode === "image" || toolMode === "video";
}

function setMode(mode) {
  toolMode = mode;
  el("toolMode").value = mode;
  updateChatModelVisibility();
  el("mediaControls").hidden = mode !== "image" && mode !== "video";
  el("mediaFormat").value = mode === "video" ? "landscape" : "square";
  input.placeholder = ({
    auto: "Ask or create…",
    document: "Ask about a PDF or compare project documents…",
    web: "What should I look up?",
    image: "Describe the image you want to create or edit…",
    video: "Describe the scene, action and camera movement…",
  })[mode];
}

function resetWorkspace() {
  activeProject = null;
  pendingPdf = null;
  clearAttachment();
  for (const url of pdfUrls) URL.revokeObjectURL(url);
  pdfUrls.clear();
  pendingPdfUrl = null;
  el("workspaceTitle").textContent = "General chat";
}

function workspacePath() {
  return "/api/projects/" + encodeURIComponent(activeProject.id);
}

function setProject(project) {
  const changed = activeProject?.id !== project?.id;
  if (changed) resetWorkspace();
  activeProject = project;
  el("workspaceTitle").textContent = project?.name || "General chat";
}

function projectRequest(path, method, data) {
  return api(path, { method, headers: headers(!!data), body: data ? JSON.stringify(data) : undefined });
}

async function openProjects() {
  if (el("sendBtn").disabled) return;
  if (!user) return showModal("authModal");
  showModal("projectsModal");
  el("projectStatus").textContent = "Loading projects…";
  try {
    const { projects } = await api("/api/projects", { headers: headers() });
    const list = el("projectList");
    list.replaceChildren();
    for (const project of projects) {
      const button = btn(project.name, () => selectProject(project.id));
      button.setAttribute("aria-pressed", String(activeProject?.id === project.id));
      list.append(button);
    }
    el("projectStatus").textContent = projects.length ? "" : "Create a project to keep its PDFs and conversations together.";
    if (activeProject) await loadProjectDocuments();
  } catch (error) {
    el("projectStatus").textContent = error.message;
  }
}

async function selectProject(id, { close = true } = {}) {
  if (el("sendBtn").disabled) return;
  try {
    const data = await api("/api/projects/" + encodeURIComponent(id), { headers: headers() });
    setProject(data.project);
    history = data.messages.map(message => ({ ...message, projectId: id }));
    render();
    paintDocuments(data.documents);
    if (close) hideModal("projectsModal");
  } catch (error) {
    el("projectStatus").textContent = error.message;
  }
}

async function loadProjectDocuments() {
  const data = await api(workspacePath(), { headers: headers() });
  if (activeProject?.id === data.project.id) paintDocuments(data.documents);
}

function paintDocuments(documents) {
  el("projectDetails").hidden = !activeProject;
  el("activeProjectName").textContent = activeProject?.name || "";
  const list = el("documentList");
  list.replaceChildren();
  for (const document of documents) {
    const row = window.document.createElement("li");
    const label = window.document.createElement("span");
    label.textContent = `${document.name} · ${document.pageCount} pages`;
    row.append(label, btn("Remove", async () => {
      if (!confirm(`Remove ${document.name} from this project?`)) return;
      try {
        await projectRequest(workspacePath() + "/documents/" + encodeURIComponent(document.id), "DELETE");
        await loadProjectDocuments();
      } catch (error) {
        el("projectStatus").textContent = error.message;
      }
    }));
    list.append(row);
  }
}

async function uploadProjectDocument(file) {
  const form = new FormData();
  form.set("file", file);
  return api(workspacePath() + "/documents", { method: "POST", headers: headers(), body: form });
}

function validWebUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function renderCitations(message, container) {
  if (!message.citations?.length) return;
  const group = document.createElement("div");
  group.className = "citations";
  const label = document.createElement("strong");
  label.textContent = "Sources";
  group.append(label);
  for (const ref of message.citations) {
    const name = `[${ref.id}] ${ref.title}${ref.page ? " · p. " + ref.page : ""}`;
    const href = ref.documentId === "attachment" && message.pdfUrl ? message.pdfUrl + "#page=" + ref.page : validWebUrl(ref.url);
    if (href) {
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = name;
      group.append(link);
    } else if (ref.documentId && message.projectId) {
      group.append(btn(name, async () => {
        el("sourceTitle").textContent = name;
        el("sourceText").textContent = "Loading page…";
        showModal("sourceModal");
        try {
          const path = `/api/projects/${encodeURIComponent(message.projectId)}/documents/${encodeURIComponent(ref.documentId)}/pages/${Number(ref.page)}`;
          const data = await api(path, { headers: headers() });
          el("sourceText").textContent = data.text;
        } catch (error) {
          el("sourceText").textContent = error.message;
        }
      }));
    }
  }
  if (group.children.length > 1) container.append(group);
}

async function openDigest(refresh = false) {
  if (!user?.is_admin) return;
  showModal("digestModal");
  el("digestRefresh").disabled = true;
  el("digestStatus").textContent = "Loading Notion digest…";
  try {
    const data = await projectRequest("/api/notion/digest", refresh ? "POST" : "GET");
    const report = data.digest;
    const list = el("digestList");
    list.replaceChildren();
    el("digestStatus").textContent = !data.configured ? "Configure the Notion token on the Worker to enable the weekly digest."
      : !report ? "The next scheduled run will prepare a digest. You can also run it now."
      : `Week of ${report.week} · ${report.items.length} open items${report.hasMore ? " from " + report.scanned + " scanned records" : ""}`;
    for (const item of report?.items || []) {
      const row = document.createElement("li");
      const link = document.createElement("a");
      link.textContent = item.title || "Untitled task";
      link.href = validWebUrl(item.url) || "#";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const detail = document.createElement("span");
      detail.textContent = [item.status, item.priority, item.due ? (item.overdue ? "Overdue " : "Due ") + item.due : "", item.notes].filter(Boolean).join(" · ");
      row.append(link, detail);
      list.append(row);
    }
  } catch (error) {
    el("digestStatus").textContent = error.message;
  } finally {
    el("digestRefresh").disabled = false;
  }
}

async function captureVoice() {
  if (!user) return showModal("authModal");
  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
    return;
  }
  const button = el("voiceBtn");
  const status = el("composerStatus");
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    status.textContent = "Voice recording requires a browser with microphone access.";
    return;
  }
  button.disabled = true;
  status.textContent = "Waiting for microphone permission…";
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const owner = user.id;
    mediaRecorder = recorder;
    const chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    const timeout = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 45000);
    recorder.onstop = async () => {
      clearTimeout(timeout);
      stream.getTracks().forEach(track => track.stop());
      button.textContent = "Mic";
      button.setAttribute("aria-pressed", "false");
      button.disabled = true;
      if (user?.id !== owner) {
        status.textContent = "";
        mediaRecorder = null;
        button.disabled = false;
        return;
      }
      status.textContent = "Transcribing…";
      try {
        const form = new FormData();
        form.set("audio", new Blob(chunks, { type: recorder.mimeType || "audio/webm" }), "voice");
        form.set("language", el("voiceLanguage").value);
        const data = await api("/api/voice/transcribe", { method: "POST", headers: headers(), body: form });
        if (user?.id === owner) {
          input.value = [input.value.trim(), data.text].filter(Boolean).join(" ");
          input.focus();
          autoGrow();
          status.textContent = "Transcript added. You can edit it before sending.";
        }
      } catch (error) {
        status.textContent = error.message;
      } finally {
        button.disabled = false;
        mediaRecorder = null;
      }
    };
    recorder.start();
    button.textContent = "Stop";
    button.setAttribute("aria-pressed", "true");
    button.disabled = false;
    status.textContent = "Recording. Select Stop when ready.";
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    status.textContent = error.message || "Could not start the microphone.";
    button.disabled = false;
  }
}

async function copyMessage(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const previous = document.activeElement;
    const clipboardInput = document.createElement("textarea");
    clipboardInput.value = text;
    clipboardInput.readOnly = true;
    clipboardInput.style.position = "fixed";
    clipboardInput.style.opacity = "0";
    document.body.append(clipboardInput);
    clipboardInput.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    } finally {
      clipboardInput.remove();
      previous?.focus();
    }
    if (!copied) {
      el("composerStatus").textContent = "Select the message text and use your browser’s Copy command.";
      return;
    }
  }
  el("composerStatus").textContent = "Copied.";
}

async function pasteFromClipboard() {
  const status = el("composerStatus");
  const selection = [input.selectionStart, input.selectionEnd];
  const draft = input.value;
  let text;
  try {
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read();
      const imageItem = items.find(item => item.types.some(type => type.startsWith("image/")));
      if (imageItem) {
        const type = imageItem.types.find(type => type.startsWith("image/"));
        const blob = await imageItem.getType(type);
        await pickFile(new File([blob], "clipboard-image." + type.split("/")[1], { type: blob.type || type }));
        input.focus();
        return;
      }
      const textItem = items.find(item => item.types.includes("text/plain"));
      if (textItem) text = await (await textItem.getType("text/plain")).text();
    }
  } catch {
    // Some browsers support reading plain text only.
  }
  try {
    text ??= await navigator.clipboard.readText();
    if (!text) {
      status.textContent = "No text or image found on the clipboard.";
      return;
    }
    input.focus();
    if (input.value === draft) input.setRangeText(text, ...selection, "end");
    else input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
    autoGrow();
    status.textContent = "Pasted into your draft.";
  } catch {
    input.focus();
    status.textContent = "Use Ctrl+V, Command+V, or touch and hold the message field to paste.";
  }
}

function initWorkspace() {
  el("pasteBtn").onclick = pasteFromClipboard;
  input.addEventListener("paste", event => {
    const image = Array.from(event.clipboardData?.files || []).find(file => file.type.startsWith("image/"));
    if (!image) return;
    event.preventDefault();
    pickFile(image);
  });
  el("toolMode").onchange = event => setMode(event.target.value);
  document.querySelectorAll("[data-mode]").forEach(button => button.onclick = () => {
    setMode(button.dataset.mode);
    input.focus();
  });
  el("projectsBtn").onclick = openProjects;
  el("digestBtn").onclick = () => openDigest();
  el("digestMenuBtn").onclick = () => { closeDrawer(); openDigest(); };
  el("digestRefresh").onclick = () => openDigest(true);
  el("voiceBtn").onclick = captureVoice;
  el("signInBtn").onclick = () => user ? showAccount() : showModal("authModal");
  el("authClose").onclick = () => hideModal("authModal");
  el("generalChat").onclick = async () => {
    if (el("sendBtn").disabled) return;
    setProject(null);
    el("projectDetails").hidden = true;
    hideModal("projectsModal");
    await loadHistory();
  };
  el("projectForm").onsubmit = async event => {
    event.preventDefault();
    const button = el("createProject");
    button.disabled = true;
    try {
      const { project } = await projectRequest("/api/projects", "POST", { name: el("projectName").value, instructions: el("projectInstructions").value });
      event.target.reset();
      await selectProject(project.id);
    } catch (error) {
      el("projectStatus").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
  el("projectFile").onchange = async event => {
    const file = event.target.files[0];
    if (!file || !activeProject) return;
    event.target.disabled = true;
    el("projectStatus").textContent = "Extracting text from PDF…";
    try {
      await uploadProjectDocument(file);
      await loadProjectDocuments();
      el("projectStatus").textContent = "PDF added to this project.";
    } catch (error) {
      el("projectStatus").textContent = error.message;
    } finally {
      event.target.value = "";
      event.target.disabled = false;
    }
  };
  el("deleteProject").onclick = async () => {
    if (!activeProject || !confirm(`Delete ${activeProject.name}, its PDFs and its chat?`)) return;
    try {
      await projectRequest(workspacePath(), "DELETE");
      await el("generalChat").onclick();
    } catch (error) {
      el("projectStatus").textContent = error.message;
    }
  };
}
