import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DemoBanner } from "./DemoBanner";

describe("DemoBanner", () => {
  it("is a landmark named « Mode démo », says there is no AI, and says how to have the real models", () => {
    render(<DemoBanner />);

    const banner = screen.getByRole("complementary", { name: "Mode démo" });
    expect(banner).toHaveTextContent("Mode démo : lecteur simplifié, pas d'IA.");
    expect(banner).toHaveTextContent(/lancez l'application avec une clé/);
    // not announced as news, not something to close
    expect(banner).not.toHaveAttribute("role", "status");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
