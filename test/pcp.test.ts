import { describe, it, expect } from "vitest";
import { encode, decode, pcpEscape, pcpUnescape, SUBPROTOCOL } from "../src/pcp.js";

describe("SUBPROTOCOL", () => {
	it("is the PCP v1.0 identifier", () => {
		expect(SUBPROTOCOL).toBe("v10.pcp.sap.com");
	});
});

describe("pcpEscape", () => {
	it("escapes backslash, colon, and newline", () => {
		expect(pcpEscape("a\\b")).toBe("a\\\\b");
		expect(pcpEscape("k:v")).toBe("k\\:v");
		expect(pcpEscape("a\nb")).toBe("a\\nb");
	});

	it("escapes backslash before colon/newline (order matters)", () => {
		// Backslash MUST be escaped first; otherwise the colon escape's
		// inserted backslash would itself get escaped on the second pass.
		expect(pcpEscape(":")).toBe("\\:");
		expect(pcpEscape("\n")).toBe("\\n");
		expect(pcpEscape("\\")).toBe("\\\\");
		expect(pcpEscape("\\:")).toBe("\\\\\\:");
	});

	it("returns the input unchanged when there is nothing to escape", () => {
		expect(pcpEscape("")).toBe("");
		expect(pcpEscape("plain")).toBe("plain");
		expect(pcpEscape("héllo-世界")).toBe("héllo-世界");
	});
});

describe("pcpUnescape", () => {
	it("decodes the three recognized escapes", () => {
		expect(pcpUnescape("\\\\")).toBe("\\");
		expect(pcpUnescape("\\:")).toBe(":");
		expect(pcpUnescape("\\n")).toBe("\n");
	});

	it("returns the input unchanged when there is nothing to unescape", () => {
		expect(pcpUnescape("")).toBe("");
		expect(pcpUnescape("plain")).toBe("plain");
		expect(pcpUnescape("héllo-世界")).toBe("héllo-世界");
	});

	it("decodes adjacent escapes left-to-right without overlap", () => {
		// `\\` consumes both characters before the next match attempt, so a
		// following `\:` or `\n` cannot be eaten by a greedy second pass —
		// this is the failure mode the placeholder dance used to guard.
		expect(pcpUnescape("\\\\:")).toBe("\\:");
		expect(pcpUnescape("\\\\\\:")).toBe("\\:");
		expect(pcpUnescape("\\\\\\\\")).toBe("\\\\");
		expect(pcpUnescape("\\\\n")).toBe("\\n");
		expect(pcpUnescape("\\\\\\n")).toBe("\\\n");
	});

	it("passes a stray backslash through when followed by a non-escape character", () => {
		// The PCP spec defines exactly three escapes (`\\`, `\:`, `\n`); any
		// other backslash sequence is undefined. We mirror SapPcpWebSocket
		// and leave such bytes untouched.
		expect(pcpUnescape("\\x")).toBe("\\x");
		expect(pcpUnescape("a\\zb")).toBe("a\\zb");
	});

	it("passes a trailing backslash through when nothing follows", () => {
		expect(pcpUnescape("trailing\\")).toBe("trailing\\");
	});

	it("decodes a single escape regardless of position", () => {
		expect(pcpUnescape("a\\:b")).toBe("a:b");
		expect(pcpUnescape("\\:lead")).toBe(":lead");
		expect(pcpUnescape("trail\\:")).toBe("trail:");
	});
});

describe("pcpEscape / pcpUnescape round-trip", () => {
	it("round-trips ascii", () => {
		expect(pcpUnescape(pcpEscape("hello"))).toBe("hello");
	});

	it("round-trips strings with all special characters", () => {
		const input = "weird:value\\with\nlinebreak";
		expect(pcpUnescape(pcpEscape(input))).toBe(input);
	});

	it("round-trips repeated backslashes without double-substitution", () => {
		const input = "a\\\\:b";
		expect(pcpUnescape(pcpEscape(input))).toBe(input);
	});

	it("round-trips every pairwise combination of special characters", () => {
		// Exhaustive over short permutations of the three escape-active
		// characters plus a benign filler, to catch any positional bug the
		// hand-picked cases above might miss.
		const atoms = ["\\", ":", "\n", "x"];
		for (const a of atoms) {
			for (const b of atoms) {
				for (const c of atoms) {
					const input = a + b + c;
					expect(pcpUnescape(pcpEscape(input))).toBe(input);
				}
			}
		}
	});
});

describe("encode", () => {
	it("emits pcp-action and pcp-body-type defaults", () => {
		const wire = encode();
		expect(wire).toContain("pcp-action:MESSAGE\n");
		expect(wire).toContain("pcp-body-type:text\n");
	});

	it("uses custom action and body-type", () => {
		const wire = encode({ action: "EVENT", bodyType: "binary" });
		expect(wire).toContain("pcp-action:EVENT\n");
		expect(wire).toContain("pcp-body-type:binary\n");
	});

	it("appends application fields after the pcp-* fields", () => {
		const wire = encode({ fields: { action: "PING", correlationId: "abc" } });
		expect(wire.indexOf("pcp-action:")).toBeLessThan(wire.indexOf("action:PING"));
		expect(wire.indexOf("pcp-body-type:")).toBeLessThan(wire.indexOf("action:PING"));
		expect(wire).toContain("action:PING\n");
		expect(wire).toContain("correlationId:abc\n");
	});

	it("strips fields with the reserved pcp- prefix", () => {
		const wire = encode({ fields: { "pcp-extra": "no", real: "yes" } });
		expect(wire).toContain("real:yes\n");
		expect(wire).not.toMatch(/pcp-extra:/);
	});

	it("throws on empty field names", () => {
		expect(() => encode({ fields: { "": "value" } })).toThrow(/non-empty/);
	});

	it("emits an empty body when none is provided", () => {
		const wire = encode({ action: "X" });
		expect(wire.endsWith("\n\n")).toBe(true);
	});

	it("escapes special characters in field values", () => {
		const wire = encode({ fields: { weird: "a:b\\c\nd" } });
		expect(wire).toContain("weird:a\\:b\\\\c\\nd\n");
	});
});

describe("decode", () => {
	it("parses fields and body separated by LFLF", () => {
		const wire = "pcp-action:MESSAGE\npcp-body-type:text\naction:PING\n\npayload";
		const result = decode(wire);
		expect(result.pcpFields["pcp-action"]).toBe("MESSAGE");
		expect(result.pcpFields["pcp-body-type"]).toBe("text");
		expect(result.pcpFields["action"]).toBe("PING");
		expect(result.body).toBe("payload");
	});

	it("falls back to body-only when no separator is present", () => {
		const result = decode("just-a-body");
		expect(result.pcpFields).toEqual({});
		expect(result.body).toBe("just-a-body");
	});

	it("unescapes special characters in field values", () => {
		const wire = "pcp-action:X\n\\:weird:a\\:b\\nc\n\n";
		const result = decode(wire);
		expect(result.pcpFields[":weird"]).toBe("a:b\nc");
	});

	it("ignores malformed lines that don't match name:value", () => {
		const wire = "pcp-action:MESSAGE\nnotafield\nreal:yes\n\nbody";
		const result = decode(wire);
		expect(result.pcpFields["pcp-action"]).toBe("MESSAGE");
		expect(result.pcpFields["real"]).toBe("yes");
		expect(result.pcpFields["notafield"]).toBeUndefined();
	});

	it("parses fields with empty values", () => {
		const wire = "pcp-action:X\nempty:\nreal:yes\n\nbody";
		const result = decode(wire);
		expect(result.pcpFields["empty"]).toBe("");
		expect(result.pcpFields["real"]).toBe("yes");
		expect(result.body).toBe("body");
	});

	it("drops empty-key lines without surfacing them as a field", () => {
		const wire = ":value\nreal:yes\n\nbody";
		const result = decode(wire);
		expect(result.pcpFields).toEqual({ real: "yes" });
		expect(result.pcpFields[""]).toBeUndefined();
		expect(result.body).toBe("body");
	});

	it("preserves an empty body", () => {
		const wire = "pcp-action:X\n\n";
		const result = decode(wire);
		expect(result.body).toBe("");
	});

	it("round-trips encode → decode with custom fields and body", () => {
		const wire = encode({ action: "EVENT", fields: { name: "alice" }, body: "hello" });
		const decoded = decode(wire);
		expect(decoded.pcpFields["pcp-action"]).toBe("EVENT");
		expect(decoded.pcpFields["name"]).toBe("alice");
		expect(decoded.body).toBe("hello");
	});
});
