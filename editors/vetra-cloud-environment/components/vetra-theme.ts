/** Vetra Design System CSS variables — injected into the editor scope */
export const vetraThemeCSS = `
  .vetra-editor {
    /* Primary */
    --v-primary: #04c161;
    --v-primary-fg: #ffffff;
    --v-primary-30: rgba(4, 193, 97, 0.3);

    /* Base */
    --v-bg: #fcfcfc;
    --v-fg: #343839;
    --v-fg-70: rgba(52, 56, 57, 0.5);
    --v-fg-50: rgba(52, 56, 57, 0.3);

    /* Card */
    --v-card: #fcfcfc;
    --v-card-fg: #343839;

    /* Muted */
    --v-muted: #efefef;
    --v-muted-fg: #9ea0a1;

    /* Border & Input */
    --v-border: #d7d8d9;
    --v-input: #ffffff;
    --v-ring: #343839;

    /* Destructive */
    --v-destructive: #ea4335;
    --v-destructive-fg: #fcfcfc;
    --v-destructive-30: rgba(234, 67, 53, 0.3);

    /* Status */
    --v-progress: #329dff;
    --v-progress-30: rgba(50, 157, 255, 0.3);
    --v-success: #4fc86f;
    --v-success-30: rgba(79, 200, 111, 0.3);
    --v-todo: #ffa132;
    --v-todo-30: rgba(255, 161, 50, 0.3);

    /* Extra */
    --v-purple: #8e55ea;
    --v-purple-30: rgba(142, 85, 234, 0.3);

    /* Accent */
    --v-accent: #f3f5f7;

    font-family: 'Inter', sans-serif;
    color: var(--v-fg);
  }

  .vetra-editor input:disabled,
  .vetra-editor select:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .vetra-editor input:focus,
  .vetra-editor select:focus {
    border-color: var(--v-primary);
    box-shadow: 0 0 0 2px var(--v-primary-30);
    outline: none;
  }

  .vetra-editor button:hover:not(:disabled) {
    opacity: 0.9;
  }
`;
