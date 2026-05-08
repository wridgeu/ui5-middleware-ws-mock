import { describe, it, expect } from "vitest";
import { encode, decode, pcpEscape, pcpUnescape, SUBPROTOCOL } from "../src/pcp.js";

describe("SUBPROTOCOL", () => {
	it("is the PCP v1.0 identifier", () => {
		expect(SUBPROTOCOL).toBe("v10.pcp.sap.com");
	});
});

describe("pcpEscape / pcpUnescape", () => {
	it("escapes backslash, colon, and newline", () => {
		expect(pcpEscape("a\\b")).toBe("a\\\\b");
		expect(pcpEscape("k:v")).toBe("k\\:v");
		expect(pcpEscape("a\nb")).toBe("a\\nb");
	});

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
