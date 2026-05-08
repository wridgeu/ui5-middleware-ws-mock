// Intentionally broken: dynamic import() rejects, driving the 1011 path.
// @ts-expect-error -- resolution failure is the point of this fixture
import "./this-module-does-not-exist.js";

export default {};
