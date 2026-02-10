import { LitElement, html, nothing } from "lit";
import {
  clearFieldValue,
  getFieldValue,
  loadPersistedDraft,
  persistDraft,
  resetDraft,
  setFieldValue,
  type ConfigDraft,
} from "../lib/config-store.ts";
import { downloadJson5File, formatConfigJson5 } from "../lib/json5-format.ts";
import {
  buildExplorerSnapshot,
  type ExplorerField,
  type ExplorerSection,
  type ExplorerSnapshot,
} from "../lib/schema-spike.ts";

type AppState =
  | { status: "loading" }
  | { status: "ready"; snapshot: ExplorerSnapshot }
  | { status: "error"; message: string };

type CopyState = "idle" | "copied" | "failed";

function includesQuery(value: string, query: string): boolean {
  return value.toLowerCase().includes(query);
}

function matchesField(field: ExplorerField, query: string): boolean {
  if (!query) {
    return true;
  }
  return (
    includesQuery(field.path, query) ||
    includesQuery(field.label, query) ||
    includesQuery(field.help, query)
  );
}

function matchesSection(section: ExplorerSection, query: string): boolean {
  if (!query) {
    return true;
  }
  return (
    includesQuery(section.id, query) ||
    includesQuery(section.label, query) ||
    includesQuery(section.description, query)
  );
}

function sectionGlyph(label: string): string {
  return label.trim().charAt(0).toUpperCase() || "•";
}

class ConfigBuilderApp extends LitElement {
  private state: AppState = { status: "loading" };
  private config: ConfigDraft = {};
  private selectedSectionId: string | null = null;
  private searchQuery = "";
  private copyState: CopyState = "idle";
  private copyResetTimer: number | null = null;

  override createRenderRoot() {
    // Match the existing OpenClaw web UI approach (global CSS classes/tokens).
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.bootstrap();
  }

  override disconnectedCallback(): void {
    if (this.copyResetTimer != null) {
      window.clearTimeout(this.copyResetTimer);
      this.copyResetTimer = null;
    }
    super.disconnectedCallback();
  }

  private bootstrap(): void {
    try {
      this.config = loadPersistedDraft();
      const snapshot = buildExplorerSnapshot();
      this.state = { status: "ready", snapshot };
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      this.state = { status: "error", message };
    }
    this.requestUpdate();
  }

  private setSection(sectionId: string | null): void {
    this.selectedSectionId = sectionId;
    this.requestUpdate();
  }

  private setSearchQuery(raw: string): void {
    this.searchQuery = raw.trim().toLowerCase();
    this.requestUpdate();
  }

  private saveConfig(next: ConfigDraft): void {
    this.config = next;
    persistDraft(next);
    this.requestUpdate();
  }

  private clearField(path: string): void {
    this.saveConfig(clearFieldValue(this.config, path));
  }

  private setField(path: string, value: unknown): void {
    this.saveConfig(setFieldValue(this.config, path, value));
  }

  private resetAllFields(): void {
    this.saveConfig(resetDraft());
  }

  private parseAndSetField(field: ExplorerField, raw: string): void {
    const trimmed = raw.trim();

    if (trimmed.length === 0) {
      this.clearField(field.path);
      return;
    }

    if (field.kind === "number" || field.kind === "integer") {
      const parsed = Number(trimmed);
      if (Number.isNaN(parsed)) {
        return;
      }
      this.setField(field.path, field.kind === "integer" ? Math.trunc(parsed) : parsed);
      return;
    }

    if (field.kind === "boolean") {
      if (trimmed === "true") {
        this.setField(field.path, true);
        return;
      }
      if (trimmed === "false") {
        this.setField(field.path, false);
      }
      return;
    }

    if (field.kind === "enum") {
      if (field.enumValues.includes(trimmed)) {
        this.setField(field.path, trimmed);
      }
      return;
    }

    this.setField(field.path, raw);
  }

  private async copyPreview(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copyState = "copied";
    } catch {
      this.copyState = "failed";
    }

    if (this.copyResetTimer != null) {
      window.clearTimeout(this.copyResetTimer);
    }

    this.copyResetTimer = window.setTimeout(() => {
      this.copyState = "idle";
      this.copyResetTimer = null;
      this.requestUpdate();
    }, 1500);

    this.requestUpdate();
  }

  private getVisibleSections(snapshot: ExplorerSnapshot): ExplorerSection[] {
    const bySection = this.selectedSectionId
      ? snapshot.sections.filter((section) => section.id === this.selectedSectionId)
      : snapshot.sections;

    const query = this.searchQuery;
    if (!query) {
      return bySection;
    }

    const visible: ExplorerSection[] = [];
    for (const section of bySection) {
      if (matchesSection(section, query)) {
        visible.push(section);
        continue;
      }
      const fields = section.fields.filter((field) => matchesField(field, query));
      if (fields.length === 0) {
        continue;
      }
      visible.push({ ...section, fields });
    }

    return visible;
  }

  private renderSearch() {
    return html`
      <div class="config-search">
        <svg
          class="config-search__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8"></circle>
          <path d="M21 21l-4.35-4.35"></path>
        </svg>
        <input
          class="config-search__input"
          type="text"
          placeholder="Search fields, labels, help…"
          @input=${(event: Event) => this.setSearchQuery((event.target as HTMLInputElement).value)}
        />
        ${this.searchQuery
          ? html`
              <button
                class="config-search__clear"
                title="Clear search"
                @click=${() => this.setSearchQuery("")}
              >
                ×
              </button>
            `
          : nothing}
      </div>
    `;
  }

  private renderSidebar(snapshot: ExplorerSnapshot) {
    return html`
      <aside class="config-sidebar">
        <div class="config-sidebar__header">
          <div>
            <div class="config-sidebar__title">Config Builder</div>
            <div class="builder-subtitle">Explorer + JSON5 preview</div>
          </div>
          <span class="pill pill--sm pill--ok">phase 2</span>
        </div>

        ${this.renderSearch()}

        <nav class="config-nav">
          <button
            class="config-nav__item ${this.selectedSectionId === null ? "active" : ""}"
            @click=${() => this.setSection(null)}
          >
            <span class="config-nav__icon builder-icon" aria-hidden="true">A</span>
            <span class="config-nav__label">All sections</span>
            <span class="builder-count mono">${snapshot.fieldCount}</span>
          </button>

          ${snapshot.sections.map(
            (section) => html`
              <button
                class="config-nav__item ${this.selectedSectionId === section.id ? "active" : ""}"
                @click=${() => this.setSection(section.id)}
              >
                <span class="config-nav__icon builder-icon" aria-hidden="true"
                  >${sectionGlyph(section.label)}</span
                >
                <span class="config-nav__label">${section.label}</span>
                <span class="builder-count mono">${section.fields.length}</span>
              </button>
            `,
          )}
        </nav>

        <div class="config-sidebar__footer">
          <div class="builder-footer-note">
            Draft values persist in localStorage and render to JSON5 preview.
          </div>
        </div>
      </aside>
    `;
  }

  private renderFieldControl(field: ExplorerField, value: unknown) {
    if (!field.editable) {
      return html`<div class="cfg-field__help">Phase 2 edits only primitive concrete paths.</div>`;
    }

    if (field.kind === "boolean") {
      return html`
        <label class="cfg-toggle-row builder-toggle-row">
          <span class="cfg-field__help">Toggle to set this boolean value.</span>
          <div class="cfg-toggle">
            <input
              type="checkbox"
              .checked=${value === true}
              @change=${(event: Event) =>
                this.setField(field.path, (event.target as HTMLInputElement).checked)}
            />
            <span class="cfg-toggle__track"></span>
          </div>
        </label>
      `;
    }

    if (field.kind === "enum") {
      const selectValue = typeof value === "string" ? value : "";
      return html`
        <select
          class="cfg-select"
          .value=${selectValue}
          @change=${(event: Event) => {
            const next = (event.target as HTMLSelectElement).value;
            if (!next) {
              this.clearField(field.path);
              return;
            }
            this.setField(field.path, next);
          }}
        >
          <option value="">(unset)</option>
          ${field.enumValues.map((option) => html`<option value=${option}>${option}</option>`)}
        </select>
      `;
    }

    if (field.kind === "number" || field.kind === "integer") {
      const textValue = typeof value === "number" ? String(value) : "";
      return html`
        <input
          class="cfg-input"
          type="number"
          .value=${textValue}
          @input=${(event: Event) =>
            this.parseAndSetField(field, (event.target as HTMLInputElement).value)}
        />
      `;
    }

    const textValue = typeof value === "string" ? value : "";
    return html`
      <input
        class="cfg-input"
        type=${field.sensitive ? "password" : "text"}
        .value=${textValue}
        @input=${(event: Event) => this.parseAndSetField(field, (event.target as HTMLInputElement).value)}
      />
    `;
  }

  private renderField(field: ExplorerField) {
    const value = getFieldValue(this.config, field.path);
    const hasValue = value !== undefined;

    return html`
      <div class="cfg-field builder-field ${hasValue ? "builder-field--set" : ""}">
        <div class="builder-field__head">
          <div class="cfg-field__label">${field.label}</div>
          <div class="builder-field__badges">
            ${hasValue ? html`<span class="pill pill--sm">set</span>` : nothing}
            ${field.sensitive ? html`<span class="pill pill--sm pill--danger">sensitive</span>` : nothing}
            ${field.advanced ? html`<span class="pill pill--sm">advanced</span>` : nothing}
            <span class="pill pill--sm mono">${field.kind}</span>
          </div>
        </div>

        <div class="builder-field__path mono">${field.path}</div>

        ${field.help ? html`<div class="cfg-field__help">${field.help}</div>` : nothing}

        <div class="builder-field__controls">${this.renderFieldControl(field, value)}</div>

        <div class="builder-field__actions">
          <button class="btn btn--sm" @click=${() => this.clearField(field.path)}>Clear</button>
        </div>
      </div>
    `;
  }

  private renderSections(visibleSections: ExplorerSection[]) {
    if (visibleSections.length === 0) {
      return html`<div class="config-empty"><div class="config-empty__text">No matching sections/fields for this filter.</div></div>`;
    }

    return html`
      <div class="config-form config-form--modern">
        ${visibleSections.map(
          (section) => html`
            <section class="config-section-card" id=${`section-${section.id}`}>
              <div class="config-section-card__header">
                <div class="config-section-card__icon builder-section-glyph" aria-hidden="true">
                  ${sectionGlyph(section.label)}
                </div>
                <div class="config-section-card__titles">
                  <h2 class="config-section-card__title">${section.label}</h2>
                  <div class="config-section-card__desc">
                    <span class="mono">${section.id}</span>
                    · ${section.fields.length} field hint${section.fields.length === 1 ? "" : "s"}
                    ${section.description ? html`<br />${section.description}` : nothing}
                  </div>
                </div>
              </div>

              <div class="config-section-card__content">
                <div class="cfg-fields">${section.fields.map((field) => this.renderField(field))}</div>
              </div>
            </section>
          `,
        )}
      </div>
    `;
  }

  private renderPreview() {
    const preview = formatConfigJson5(this.config);

    return html`
      <aside class="builder-preview">
        <div class="builder-preview__header">
          <div class="builder-preview__title mono">openclaw.json</div>
          <div class="builder-preview__meta mono">${preview.lineCount} lines · ${preview.byteCount} B</div>
        </div>

        <pre class="builder-preview__code code-block">${preview.text}</pre>

        <div class="builder-preview__footer">
          <button class="btn btn--sm" @click=${() => this.copyPreview(preview.text)}>
            ${this.copyState === "copied"
              ? "Copied"
              : this.copyState === "failed"
                ? "Copy failed"
                : "Copy"}
          </button>
          <button class="btn btn--sm" @click=${() => downloadJson5File(preview.text)}>Download</button>
          <button class="btn btn--sm danger" @click=${() => this.resetAllFields()}>Reset all</button>
        </div>
      </aside>
    `;
  }

  override render() {
    if (this.state.status === "loading") {
      return html`<div class="builder-screen"><div class="card">Loading schema explorer…</div></div>`;
    }

    if (this.state.status === "error") {
      return html`<div class="builder-screen"><pre class="callout danger">${this.state.message}</pre></div>`;
    }

    const { snapshot } = this.state;
    const visibleSections = this.getVisibleSections(snapshot);

    return html`
      <div class="builder-screen">
        <div class="config-layout builder-layout">
          ${this.renderSidebar(snapshot)}

          <main class="config-main">
            <div class="config-actions">
              <div class="config-actions__left">
                <span class="config-status">Phase 2: sparse state + live JSON5 preview</span>
              </div>
              <div class="config-actions__right">
                <span class="pill pill--sm">sections: ${snapshot.sectionCount}</span>
                <span class="pill pill--sm">fields: ${snapshot.fieldCount}</span>
                <span class="pill pill--sm mono">v${snapshot.version}</span>
              </div>
            </div>

            <div class="config-content">
              ${this.searchQuery
                ? html`<div class="builder-search-state">Search: <span class="mono">${this.searchQuery}</span></div>`
                : nothing}

              ${this.renderSections(visibleSections)}
            </div>
          </main>

          ${this.renderPreview()}
        </div>
      </div>
    `;
  }
}

customElements.define("config-builder-app", ConfigBuilderApp);
