/**
 * The wizard field schema — the single shared vocabulary every config domain
 * (channels, settings sections, …) declares. A domain only writes `ConfigField[]`;
 * the generic {@link runWizard} (see `wizard.ts`) renders it unchanged. This is
 * the scalability seam ("it should also configure other things in the future"):
 * adding a domain is one `ConfigField[]` declaration, never any UI code.
 *
 * Pure types — no imports, no runtime.
 */

/**
 * A choice in a {@link ConfigField} of `kind: "select"`. `label` is what the
 * wizard renders; `value` is what it persists. Stricter than the prompt layer's
 * optional-label `SelectOption` (a schema option always has a label), while
 * remaining assignable to it so the wizard forwards options verbatim.
 */
export interface SelectFieldOption {
	value: string;
	label: string;
}

/**
 * A single wizard field. `kind` picks the prompt primitive; `default` is the
 * fallback for an empty answer (a string for `text`/`secret`/`select`, a boolean
 * for `confirm`); `required` aborts the whole wizard when the field is left
 * empty with no default; `help` is advisory text. The discriminated union
 * carries `options` only for `select` — adding a kind means one member here and
 * one branch in `wizard.ts` (no other caller changes).
 */
export type ConfigField =
	| {
			key: string;
			label: string;
			kind: "text" | "secret";
			default?: string;
			required?: boolean;
			help?: string;
	  }
	| {
			key: string;
			label: string;
			kind: "select";
			options: SelectFieldOption[];
			default?: string;
			required?: boolean;
			help?: string;
	  }
	| {
			key: string;
			label: string;
			kind: "confirm";
			default?: boolean;
			help?: string;
	  };
