"use client";

import { useState } from "react";
import { Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";

export interface SettingsListItem {
  id: string;
  name: string;
  description: string;
}

const INPUT_CLASS =
  "w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-primary focus:shadow-[0_0_0_1px_rgba(122,167,255,.3)]";

export function SettingsListPanel({
  title,
  blurb,
  endpoint,
  namePlaceholder,
  descriptionPlaceholder,
  emptyLabel,
  initialItems,
}: {
  title: string;
  blurb: string;
  /** CRUD endpoint, e.g. /api/ideas/lists/product-lines. */
  endpoint: string;
  namePlaceholder: string;
  descriptionPlaceholder: string;
  emptyLabel: string;
  initialItems: SettingsListItem[];
}) {
  const [items, setItems] = useState(initialItems);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(method: "POST" | "PATCH" | "DELETE", body: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setItems(data.items);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (await call("POST", { name, description })) {
      setName("");
      setDescription("");
    }
  }

  function startEdit(item: SettingsListItem) {
    setEditingId(item.id);
    setEditName(item.name);
    setEditDescription(item.description);
    setError(null);
  }

  async function onSaveEdit(id: string) {
    if (await call("PATCH", { id, name: editName, description: editDescription })) {
      setEditingId(null);
    }
  }

  function onEditKeyDown(id: string): React.KeyboardEventHandler<HTMLInputElement> {
    return (e) => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        if (!busy && editName.trim()) void onSaveEdit(id);
      } else if (e.key === "Escape") {
        setEditingId(null);
      }
    };
  }

  async function onDelete(item: SettingsListItem) {
    if (!window.confirm(`Delete "${item.name}"?`)) return;
    await call("DELETE", { id: item.id });
  }

  return (
    <section className="max-w-3xl rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <div className="font-medium text-foreground">{title}</div>
        <p className="mt-1 text-sm text-muted">{blurb}</p>
      </div>

      <form onSubmit={onAdd} className="flex items-start gap-2 border-b border-border px-5 py-4">
        <div className="w-48 shrink-0">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={namePlaceholder}
            className={INPUT_CLASS}
            disabled={busy}
          />
        </div>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={descriptionPlaceholder}
          className={INPUT_CLASS}
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-primary px-3.5 text-[13px] font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Add
        </button>
      </form>

      {error && <div className="px-5 pt-3 text-sm text-red-600">{error}</div>}

      {items.length === 0 ? (
        <div className="px-5 py-6 text-sm text-muted">{emptyLabel}</div>
      ) : (
        <ul>
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-start gap-2 border-b border-border px-5 py-3 last:border-b-0"
            >
              {editingId === item.id ? (
                <>
                  <div className="w-48 shrink-0">
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={onEditKeyDown(item.id)}
                      className={INPUT_CLASS}
                      disabled={busy}
                      autoFocus
                    />
                  </div>
                  <input
                    type="text"
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    onKeyDown={onEditKeyDown(item.id)}
                    placeholder={descriptionPlaceholder}
                    className={INPUT_CLASS}
                    disabled={busy}
                  />
                  <button
                    onClick={() => onSaveEdit(item.id)}
                    disabled={busy || !editName.trim()}
                    className="rounded-md p-2 text-primary hover:bg-background disabled:opacity-50"
                    aria-label="Save"
                  >
                    <Check size={15} />
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    disabled={busy}
                    className="rounded-md p-2 text-muted hover:bg-background"
                    aria-label="Cancel"
                  >
                    <X size={15} />
                  </button>
                </>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">{item.name}</div>
                    {item.description && (
                      <div className="mt-0.5 text-sm text-muted">{item.description}</div>
                    )}
                  </div>
                  <button
                    onClick={() => startEdit(item)}
                    disabled={busy}
                    className="rounded-md p-2 text-muted hover:bg-background hover:text-foreground"
                    aria-label={`Edit ${item.name}`}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    onClick={() => onDelete(item)}
                    disabled={busy}
                    className="rounded-md p-2 text-muted hover:bg-background hover:text-red-600"
                    aria-label={`Delete ${item.name}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
