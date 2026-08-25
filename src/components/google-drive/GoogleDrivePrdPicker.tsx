"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  FileText,
  Folder,
  HardDrive,
  Loader2,
  Search,
  X,
} from "lucide-react";
import type { GoogleDriveBrowseItem } from "@/lib/types";

type Breadcrumb = { id: string; name: string };

type SelectedMap = Map<string, string>;

function containsFilter(items: GoogleDriveBrowseItem[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => item.name.toLowerCase().includes(q));
}

function ConfirmDiscardDialog({
  open,
  onStay,
  onDiscard,
}: {
  open: boolean;
  onStay: () => void;
  onDiscard: () => void;
}) {
  if (!open) return null;

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center rounded-xl bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-xl">
        <h3 className="font-semibold text-foreground">Discard changes?</h3>
        <p className="mt-2 text-sm text-muted">
          Your PRD selections will not be saved unless you click Done.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onStay}
            className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-background"
          >
            Keep selecting
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700"
          >
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}

function PrdPickerModal({
  open,
  initialSelected,
  onDone,
  onCancel,
}: {
  open: boolean;
  initialSelected: SelectedMap;
  onDone: (selected: SelectedMap) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<SelectedMap>(new Map());
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([{ id: "root", name: "Google Drive" }]);
  const [parentId, setParentId] = useState("root");
  const [folders, setFolders] = useState<GoogleDriveBrowseItem[]>([]);
  const [files, setFiles] = useState<GoogleDriveBrowseItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const isDirty = useMemo(() => {
    if (draft.size !== initialSelected.size) return true;
    for (const [id, name] of draft) {
      if (initialSelected.get(id) !== name) return true;
    }
    return false;
  }, [draft, initialSelected]);

  useEffect(() => {
    if (!open) return;
    setDraft(new Map(initialSelected));
    setBreadcrumbs([{ id: "root", name: "Google Drive" }]);
    setParentId("root");
    setSearch("");
    setDebouncedSearch("");
    setConfirmDiscard(false);
    setError(null);
  }, [open, initialSelected]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search, open]);

  const loadBrowse = useCallback(async (parent: string, query: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      else params.set("parent", parent);
      const response = await fetch(`/api/google-drive/browse?${params.toString()}`);
      const data = await response.json();
      if (data?.error) {
        setError(data.error);
        setFolders([]);
        setFiles([]);
      } else {
        setFolders(data.folders ?? []);
        setFiles(data.files ?? []);
      }
    } catch {
      setError("Could not load Google Drive.");
      setFolders([]);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    if (debouncedSearch) {
      loadBrowse(parentId, debouncedSearch);
    } else {
      loadBrowse(parentId, "");
    }
  }, [open, parentId, debouncedSearch, loadBrowse]);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  const visibleFolders = useMemo(
    () => containsFilter(folders, search),
    [folders, search]
  );
  const visibleFiles = useMemo(
    () => containsFilter(files, search),
    [files, search]
  );

  function openFolder(item: GoogleDriveBrowseItem) {
    setParentId(item.id);
    setBreadcrumbs((prev) => [...prev, { id: item.id, name: item.name }]);
    setSearch("");
    setDebouncedSearch("");
  }

  function navigateTo(index: number) {
    if (debouncedSearch) {
      setSearch("");
      setDebouncedSearch("");
    }
    const crumb = breadcrumbs[index];
    setBreadcrumbs(breadcrumbs.slice(0, index + 1));
    setParentId(crumb.id);
  }

  function toggleFile(file: GoogleDriveBrowseItem) {
    setDraft((prev) => {
      const next = new Map(prev);
      if (next.has(file.id)) next.delete(file.id);
      else next.set(file.id, file.name);
      return next;
    });
  }

  function removeDraft(id: string) {
    setDraft((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

  function requestCancel() {
    if (isDirty) setConfirmDiscard(true);
    else onCancel();
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="prd-picker-title"
        className="relative flex h-[min(544px,76.5vh)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <ConfirmDiscardDialog
          open={confirmDiscard}
          onStay={() => setConfirmDiscard(false)}
          onDiscard={() => {
            setConfirmDiscard(false);
            onCancel();
          }}
        />

        <div className="border-b border-border px-5 py-4">
          <h2 id="prd-picker-title" className="text-lg font-semibold">
            Select PRDs
          </h2>
          <p className="text-sm text-muted">Choose Google Docs from My Drive or shared drives.</p>
        </div>

        <div className="border-b border-border px-5 py-3">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search folders and files…"
              className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:border-primary/50"
              autoFocus
            />
          </div>

          {!debouncedSearch && (
            <div className="mt-2 flex flex-wrap items-center gap-1 text-xs text-muted">
              {breadcrumbs.map((crumb, index) => (
                <span key={crumb.id} className="flex items-center gap-1">
                  {index > 0 && <ChevronRight size={12} />}
                  <button
                    type="button"
                    onClick={() => navigateTo(index)}
                    className={
                      index === breadcrumbs.length - 1
                        ? "font-medium text-foreground"
                        : "hover:text-primary"
                    }
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </div>
          )}
          {debouncedSearch && (
            <p className="mt-2 text-xs text-muted">
              Showing results containing &ldquo;{debouncedSearch}&rdquo;
            </p>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted">
              <Loader2 size={14} className="animate-spin" />
              Loading…
            </div>
          ) : error ? (
            <p className="py-8 text-sm text-red-600">{error}</p>
          ) : visibleFolders.length === 0 && visibleFiles.length === 0 ? (
            <p className="py-8 text-sm text-muted">
              {search ? "No folders or files match your search." : "This folder is empty."}
            </p>
          ) : (
            <div className="space-y-4">
              {visibleFolders.length > 0 && (
                <div>
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                    Folders
                  </div>
                  <div className="divide-y divide-border rounded-lg border border-border">
                    {visibleFolders.map((folder) => (
                      <button
                        key={folder.id}
                        type="button"
                        onClick={() => openFolder(folder)}
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-background"
                      >
                        {folder.type === "shared_drive" ? (
                          <HardDrive size={16} className="shrink-0 text-primary" />
                        ) : (
                          <Folder size={16} className="shrink-0 text-primary" />
                        )}
                        <span className="min-w-0 flex-1 truncate font-medium">{folder.name}</span>
                        <ChevronRight size={14} className="shrink-0 text-muted" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {visibleFiles.length > 0 && (
                <div>
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                    Files
                  </div>
                  <div className="divide-y divide-border rounded-lg border border-border">
                    {visibleFiles.map((file) => (
                      <label
                        key={file.id}
                        className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm hover:bg-background"
                      >
                        <input
                          type="checkbox"
                          checked={draft.has(file.id)}
                          onChange={() => toggleFile(file)}
                          className="rounded"
                        />
                        <FileText size={16} className="shrink-0 text-primary" />
                        <span className="min-w-0 flex-1 truncate">{file.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-border bg-background/80 px-5 py-3">
          <div className="mb-2 text-xs font-medium text-muted">
            Selected ({draft.size})
          </div>
          {draft.size === 0 ? (
            <p className="text-sm text-muted">No PRDs selected yet.</p>
          ) : (
            <div className="mb-3 flex max-h-24 flex-wrap gap-2 overflow-y-auto">
              {Array.from(draft.entries()).map(([id, name]) => (
                <span
                  key={id}
                  className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs"
                >
                  <span className="truncate">{name}</span>
                  <button
                    type="button"
                    onClick={() => removeDraft(id)}
                    className="text-muted hover:text-foreground"
                    aria-label={`Remove ${name}`}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={requestCancel}
              className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-card"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onDone(draft)}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function GoogleDrivePrdPicker({
  selectedIds,
  onChange,
}: {
  selectedIds: Set<string>;
  onChange: (ids: Set<string>) => void;
}) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedNames, setSelectedNames] = useState<SelectedMap>(new Map());

  useEffect(() => {
    fetch("/api/google-drive/status")
      .then((r) => r.json())
      .then((data) => setConnected(Boolean(data.status?.connected)))
      .catch(() => setConnected(false));
  }, []);

  const initialSelected = useMemo(() => {
    const map = new Map<string, string>();
    for (const id of selectedIds) {
      map.set(id, selectedNames.get(id) ?? "Google Doc");
    }
    return map;
  }, [selectedIds, selectedNames]);

  function handleDone(selected: SelectedMap) {
    setSelectedNames(selected);
    onChange(new Set(selected.keys()));
    setModalOpen(false);
  }

  function removeCommitted(id: string) {
    const next = new Set(selectedIds);
    next.delete(id);
    setSelectedNames((prev) => {
      const map = new Map(prev);
      map.delete(id);
      return map;
    });
    onChange(next);
  }

  if (connected === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={14} className="animate-spin" />
        Checking Google Drive…
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-background p-4 text-sm text-muted">
        <a href="/settings/jira" className="font-medium text-primary hover:underline">
          Connect Google Drive
        </a>{" "}
        in Settings to import PRDs from Google Docs.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-card"
      >
        Select PRDs
      </button>

      {selectedIds.size > 0 && (
        <div className="rounded-lg border border-border bg-background p-4">
          <div className="mb-2 text-xs font-medium text-muted">
            Selected PRDs ({selectedIds.size})
          </div>
          <div className="flex flex-wrap gap-2">
            {Array.from(selectedIds).map((id) => (
              <span
                key={id}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs"
              >
                <FileText size={12} className="shrink-0 text-primary" />
                <span className="truncate">{selectedNames.get(id) ?? "Google Doc"}</span>
                <button
                  type="button"
                  onClick={() => removeCommitted(id)}
                  className="text-muted hover:text-foreground"
                  aria-label="Remove"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <PrdPickerModal
        open={modalOpen}
        initialSelected={initialSelected}
        onDone={handleDone}
        onCancel={() => setModalOpen(false)}
      />
    </div>
  );
}
