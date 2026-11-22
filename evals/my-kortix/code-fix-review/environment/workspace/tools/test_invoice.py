from invoice import invoice_total


def test_discount():
    assert invoice_total(200, 10) == 180


def test_no_discount():
    assert invoice_total(100) == 100
