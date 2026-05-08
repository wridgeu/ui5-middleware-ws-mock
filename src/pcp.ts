/**
 * Push Channel Protocol (PCP) v1.0 encoder/decoder.
 *
 * Implementation of the wire format described in the SAP Community spec
 * "Specification of the Push Channel Protocol (PCP)".
 *
 * Wire format (LF = `\n`, 0x0A):
 *
 *     pcp-action:MESSAGE
 *     pcp-body-type:text
 *     <field>:<value>
 *     ...
 *     <LF>
 *     <body>
 *
 * Header and body are separated by a blank line (LFLF). Field names and
 * values are UTF-8 and case-sensitive. The characters `\`, `:` and LF inside
 * names/values are escaped as `\\`, `\:` and `\n` respectively.
 *
 * The encoding produced here is byte-compatible with
 * `sap.ui.core.ws.SapPcpWebSocket`, so frames can be exchanged in both
 * directions without translation.
 */

const SEPARATOR = "\n\n";
const PCP_ACTION = "pcp-action";
const PCP_BODY_TYPE = "pcp-body-type";
const DEFAULT_ACTION = "MESSAGE";
const DEFAULT_BODY_TYPE = "text";

/**
 * Placeholder (U+0008 BACKSPACE) used while unescaping to avoid
 * double-substituting `\\` sequences. Written as the explicit `\u0008`
 * escape because the literal character is invisible in most editors and
 * easy to delete by accident.
 */
const UNESCAPE_PLACEHOLDER = "\u0008";

/** WebSocket subprotocol identifier for PCP v1.0. */
export const SUBPROTOCOL = "v10.pcp.sap.com";

/**
 * Escape a header name or value per the PCP spec.
 */
export function pcpEscape(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/\n/g, "\\n");
}

/**
 * Unescape a header name or value per the PCP spec.
 *
 * Uses a non-printable placeholder (U+0008) while reversing escapes, matching
 * the trick SapPcpWebSocket uses to avoid double-substitution of `\\`.
 */
export function pcpUnescape(value: string): string {
	return value
		.split(UNESCAPE_PLACEHOLDER)
		.map((part) =>
			part
				.replace(/\\\\/g, UNESCAPE_PLACEHOLDER)
				.replace(/\\:/g, ":")
				.replace(/\\n/g, "\n")
				.replace(new RegExp(UNESCAPE_PLACEHOLDER, "g"), "\\"),
		)
		.join(UNESCAPE_PLACEHOLDER);
}

/**
 * Same regex SapPcpWebSocket uses to extract `name:value` pairs from a header
 * line. Captures key and value while honoring backslash escapes.
 */
const FIELD_REGEX = /((?:[^:\\]|(?:\\.))+):((?:[^:\\\n]|(?:\\.))*)/;

export interface EncodeOptions {
	/** Value for `pcp-action`. Defaults to `"MESSAGE"`. */
	action?: string;
	/** Value for `pcp-body-type` (`"text"` or `"binary"`). Defaults to `"text"`. */
	bodyType?: string;
	/**
	 * Additional application-defined fields. Names must be non-empty and must
	 * not start with `pcp-`; `pcp-*` entries are silently dropped.
	 */
	fields?: Record<string, string>;
	/**
	 * Message body. For binary content, pre-encode to Base64 and pass
	 * `bodyType: "binary"`.
	 */
	body?: string;
}

/**
 * Encode a PCP message into its wire string.
 *
 * `pcp-action` and `pcp-body-type` are emitted first, in that order, even if
 * the caller passes them inside `fields` (`pcp-*` entries in `fields` are
 * ignored, matching the spec's reserved-prefix rule).
 *
 * @throws {Error} If a field name is the empty string.
 */
export function encode(options: EncodeOptions = {}): string {
	const {
		action = DEFAULT_ACTION,
		bodyType = DEFAULT_BODY_TYPE,
		fields = {},
		body = "",
	} = options;
	let header = `${PCP_ACTION}:${pcpEscape(action)}\n${PCP_BODY_TYPE}:${pcpEscape(bodyType)}\n`;
	for (const [name, value] of Object.entries(fields)) {
		if (name.startsWith("pcp-")) continue;
		if (name === "") {
			// Empty names cannot be parsed back: SapPcpWebSocket's regex
			// requires at least one character before the colon, so empty names
			// would silently lose data on the wire. Fail loudly instead.
			throw new Error("PCP field names must be non-empty");
		}
		header += `${pcpEscape(name)}:${pcpEscape(value)}\n`;
	}
	return header + "\n" + body;
}

export interface DecodeResult {
	/**
	 * Flat key/value map containing all header fields including `pcp-action`
	 * and `pcp-body-type` (mirrors what `SapPcpWebSocket` exposes).
	 */
	pcpFields: Record<string, string>;
	body: string;
}

/**
 * Decode a PCP wire string into its parts.
 *
 * If no header/body separator (LFLF) is present, the input is treated as a
 * body-only message with empty `pcpFields`, matching SapPcpWebSocket's
 * fallback behavior.
 */
export function decode(text: string): DecodeResult {
	const splitPos = text.indexOf(SEPARATOR);
	if (splitPos === -1) {
		return { pcpFields: {}, body: text };
	}
	const headerPart = text.substring(0, splitPos);
	const body = text.substring(splitPos + SEPARATOR.length);
	const pcpFields: Record<string, string> = {};
	for (const line of headerPart.split("\n")) {
		const match = line.match(FIELD_REGEX);
		if (!match) continue;
		const [, key, value] = match;
		if (key !== undefined && value !== undefined) {
			pcpFields[pcpUnescape(key)] = pcpUnescape(value);
		}
	}
	return { pcpFields, body };
}
