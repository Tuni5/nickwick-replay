"""
specs.py - the contracts: tick size and dollars per point, one table for the server and (through /tl/sessions) the
page. An unknown symbol gets its tick inferred from its own data (archive.py: the finest price step in a day's
levels) and 1 $ a point, and the settings page shows what was taken.
"""
import math

SPECS = {
    # index
    "ES": (0.25, 50.0, "E-mini S&P 500"), "MES": (0.25, 5.0, "Micro E-mini S&P 500"),
    "NQ": (0.25, 20.0, "E-mini Nasdaq-100"), "MNQ": (0.25, 2.0, "Micro E-mini Nasdaq-100"),
    "YM": (1.0, 5.0, "E-mini Dow"), "MYM": (1.0, 0.5, "Micro E-mini Dow"),
    "RTY": (0.1, 50.0, "E-mini Russell 2000"), "M2K": (0.1, 5.0, "Micro E-mini Russell 2000"),
    "NKD": (5.0, 5.0, "Nikkei 225 (USD)"), "EMD": (0.1, 100.0, "E-mini S&P MidCap 400"),
    # energy
    "CL": (0.01, 1000.0, "Crude Oil"), "MCL": (0.01, 100.0, "Micro Crude Oil"), "QM": (0.025, 500.0, "E-mini Crude Oil"),
    "NG": (0.001, 10000.0, "Natural Gas"), "MNG": (0.001, 1000.0, "Micro Natural Gas"), "QG": (0.005, 2500.0, "E-mini Natural Gas"),
    "RB": (0.0001, 42000.0, "RBOB Gasoline"), "HO": (0.0001, 42000.0, "Heating Oil"), "BZ": (0.01, 1000.0, "Brent"),
    # metals
    "GC": (0.1, 100.0, "Gold"), "MGC": (0.1, 10.0, "Micro Gold"), "SI": (0.005, 5000.0, "Silver"), "SIL": (0.005, 1000.0, "Micro Silver"),
    "HG": (0.0005, 25000.0, "Copper"), "MHG": (0.0005, 2500.0, "Micro Copper"), "PL": (0.1, 50.0, "Platinum"), "PA": (0.1, 100.0, "Palladium"),
    # rates (prices in 32nds / 64ths come from the bridge as decimals)
    "ZB": (1 / 32, 1000.0, "30-Year T-Bond"), "ZN": (1 / 64, 1000.0, "10-Year T-Note"), "ZF": (1 / 128, 1000.0, "5-Year T-Note"),
    "ZT": (1 / 256, 2000.0, "2-Year T-Note"), "UB": (1 / 32, 1000.0, "Ultra T-Bond"), "TN": (1 / 64, 1000.0, "Ultra 10-Year"),
    # currencies
    "6E": (0.00005, 125000.0, "Euro FX"), "M6E": (0.0001, 12500.0, "Micro Euro FX"), "6J": (0.0000005, 12500000.0, "Japanese Yen"),
    "6B": (0.0001, 62500.0, "British Pound"), "M6B": (0.0001, 6250.0, "Micro British Pound"), "6A": (0.00005, 100000.0, "Australian Dollar"),
    "6C": (0.00005, 100000.0, "Canadian Dollar"), "6S": (0.00005, 125000.0, "Swiss Franc"), "DX": (0.005, 1000.0, "US Dollar Index"),
    # agriculture
    "ZC": (0.25, 50.0, "Corn"), "ZS": (0.25, 50.0, "Soybeans"), "ZW": (0.25, 50.0, "Wheat"), "ZM": (0.1, 100.0, "Soybean Meal"),
    "ZL": (0.01, 600.0, "Soybean Oil"), "KC": (0.05, 375.0, "Coffee"), "SB": (0.01, 1120.0, "Sugar"), "CT": (0.01, 500.0, "Cotton"),
    "LE": (0.025, 400.0, "Live Cattle"), "HE": (0.025, 400.0, "Lean Hogs"),
    # crypto
    "BTC": (5.0, 5.0, "Bitcoin"), "MBT": (5.0, 0.1, "Micro Bitcoin"), "ETH": (0.5, 50.0, "Ether"), "MET": (0.5, 0.1, "Micro Ether"),
}

_inferred = {}                                                  # root -> (tick, pv, name) for symbols not in the table


def spec(root):
    """(tick, point value, name) of a symbol"""
    return SPECS.get(root) or _inferred.get(root) or (0.25, 1.0, root)


def tick_of(root):
    return spec(root)[0]


def point_value(root):
    return spec(root)[1]


def learn(root, prices):
    """an unknown symbol: its tick is the finest step between its traded prices (the gcd of the differences, in
    units of 1e-7); remembered for the run"""
    if root in SPECS or root in _inferred or len(prices) < 2:
        return
    ps = sorted({int(round(p * 1e7)) for p in prices})
    g = 0
    for a, b in zip(ps, ps[1:]):
        g = math.gcd(g, b - a)
        if g == 1:
            break
    if g > 0:
        _inferred[root] = (g / 1e7, 1.0, root)


def known():
    """every symbol with a tick: the table and what was learned"""
    return {r: {"tick": s[0], "pv": s[1], "name": s[2], "source": "table" if r in SPECS else "data"} for r, s in {**SPECS, **_inferred}.items()}
