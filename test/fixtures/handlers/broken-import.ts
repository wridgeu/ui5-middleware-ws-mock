// Intentionally broken: this import resolves to nothing, so dynamic import() at
// middleware startup will reject. Tests rely on this to drive the
// "handler unavailable" 1011 close path.
import "./this-module-does-not-exist.js";

export default {};
