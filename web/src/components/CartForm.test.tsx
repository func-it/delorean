import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { EXAMPLES } from "@/lib/examples";

import { CartForm } from "./CartForm";

function renderForm({ pending = false } = {}) {
  const onSubmit = vi.fn();
  function Harness() {
    const [cart, setCart] = useState("");
    return <CartForm cart={cart} onCartChange={setCart} onSubmit={onSubmit} pending={pending} />;
  }
  render(<Harness />);
  return { onSubmit, cart: screen.getByRole("textbox", { name: "Votre panier" }) };
}

describe("CartForm", () => {
  it.each(["{Control>}{Enter}{/Control}", "{Meta>}{Enter}{/Meta}"])("submits on %s", async (keys) => {
    const { onSubmit, cart } = renderForm();

    await userEvent.type(cart, "Back to the Future 1");
    await userEvent.keyboard(keys);

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(cart).toHaveValue("Back to the Future 1");
  });

  it("keeps Enter alone for a new line", async () => {
    const { onSubmit, cart } = renderForm();

    await userEvent.type(cart, "Back to the Future 1{Enter}Back to the Future 2");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(cart).toHaveValue("Back to the Future 1\nBack to the Future 2");
  });

  it("fills the cart with an example, ready to submit", async () => {
    const { cart } = renderForm();
    const injection = EXAMPLES.find((example) => example.id === "injection")!;

    await userEvent.click(screen.getByRole("button", { name: injection.label }));

    expect(cart).toHaveValue(injection.cart);
    expect(cart).toHaveFocus();
  });

  it("offers the five carts of the brief and three more", () => {
    renderForm();

    const examples = screen.getAllByRole("button").filter((button) => button.getAttribute("type") === "button");
    expect(examples.map((button) => button.textContent)).toEqual(EXAMPLES.map((example) => example.label));
    expect(examples).toHaveLength(8);
  });

  it("disables the submit button while a quote is pending", () => {
    renderForm({ pending: true });

    expect(screen.getByRole("button", { name: "Calcul en cours…" })).toBeDisabled();
  });
});
