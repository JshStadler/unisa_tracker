import { describe, expect, it } from "vitest";
import { isValidIsoDate, validateState } from "../src/worker.js";

describe("isValidIsoDate", () => {
  it("accepts real dates in 2026", () => {
    expect(isValidIsoDate("2026-07-10")).toBe(true);
    expect(isValidIsoDate("2026-02-28")).toBe(true);
  });

  it("rejects malformed, impossible, and out-of-year dates", () => {
    expect(isValidIsoDate("2026-02-30")).toBe(false);
    expect(isValidIsoDate("2027-01-01")).toBe(false);
    expect(isValidIsoDate("10 Jul 2026")).toBe(false);
  });
});

describe("validateState", () => {
  it("accepts a valid tracker state", () => {
    expect(validateState({
      completion: { "COS1512:3": "done", "MAT1512:5": "undone" },
      dates: {
        "COS1512:3": { open: "2026-07-08", due: "2026-08-18" },
        "MAT1512:5": { open: null, due: "2026-07-27" },
      },
    })).toBeNull();
  });

  it("rejects invalid completion values and keys", () => {
    expect(validateState({ completion: { "COS1512:3": true }, dates: {} })).toBe("invalid_completion");
    expect(validateState({ completion: { "bad-key": "done" }, dates: {} })).toBe("invalid_completion");
  });

  it("rejects invalid date overrides", () => {
    expect(validateState({
      completion: {},
      dates: { "COS1512:3": { open: "2026-08-19", due: "2026-08-18" } },
    })).toBe("invalid_dates");

    expect(validateState({
      completion: {},
      dates: { "COS1512:3": { due: "2026-02-30" } },
    })).toBe("invalid_dates");
  });

  it("rejects arrays and unexpected date properties", () => {
    expect(validateState({ completion: [], dates: {} })).toBe("invalid_shape");
    expect(validateState({
      completion: {},
      dates: { "COS1512:3": { due: "2026-08-18", note: "unexpected" } },
    })).toBe("invalid_dates");
  });
});
