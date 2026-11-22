def invoice_total(amount: float, discount_pct: float = 0.0) -> float:
    """The amount to pay after a percentage discount (10 means 10% off)."""
    return round(amount * discount_pct / 100, 2)
