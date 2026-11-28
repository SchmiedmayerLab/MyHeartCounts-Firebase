# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""UCUM unit normalization: source unit text or code -> canonical unit from the Grove catalog."""

from __future__ import annotations


class UnitError(ValueError):
    pass


# non-UCUM unit strings seen in uploads -> UCUM code
UNIT_ALIASES: dict[str, str] = {
    "steps": "{steps}",
    "count": "1",
    "flights": "{flights}",
    "beats/minute": "/min",
    "breaths/minute": "/min",
    "bpm": "/min",
    "lbs": "[lb_av]",
    "lb": "[lb_av]",
    "in": "[in_i]",
    "ft": "[ft_i]",
    "mi": "[mi_i]",
    "kg/m^2": "kg/m2",
    "ml/kg/min": "mL/kg/min",
    "mL/kg/min": "mL/kg/min",
    "mL/(kg.min)": "mL/kg/min",
    "C": "Cel",
    "degC": "Cel",
    "°C": "Cel",
    "F": "[degF]",
    "°F": "[degF]",
    "kcal": "kcal",
    "Cal": "kcal",
    "mg/dL": "mg/dL",
    "mmol/L": "mmol/L",
}

# (source code, canonical code) -> multiplicative factor; identity pairs are implicit
CONVERSIONS: dict[tuple[str, str], float] = {
    ("[lb_av]", "kg"): 0.45359237,
    ("g", "kg"): 0.001,
    ("[oz_av]", "kg"): 0.028349523125,
    ("kg", "[lb_av]"): 1 / 0.45359237,
    ("[in_i]", "cm"): 2.54,
    ("[in_i]", "m"): 0.0254,
    ("[ft_i]", "cm"): 30.48,
    ("[ft_i]", "m"): 0.3048,
    ("m", "cm"): 100.0,
    ("cm", "m"): 0.01,
    ("mm", "cm"): 0.1,
    ("km", "m"): 1000.0,
    ("[mi_i]", "m"): 1609.344,
    ("[yd_i]", "m"): 0.9144,
    ("kJ", "kcal"): 1 / 4.184,
    ("J", "kcal"): 1 / 4184.0,
    ("s", "min"): 1 / 60.0,
    ("h", "min"): 60.0,
    ("ms", "min"): 1 / 60000.0,
    ("s", "ms"): 1000.0,
    ("min", "s"): 60.0,
    ("km/h", "m/s"): 1 / 3.6,
    ("[mi_i]/h", "m/s"): 0.44704,
    ("mmol/L", "mg/dL"): 18.0182,
    ("[degF]", "Cel"): None,  # affine, handled explicitly
    ("1", "{steps}"): 1.0,
    ("1", "{flights}"): 1.0,
    ("{count}", "{steps}"): 1.0,
    ("{count}", "{flights}"): 1.0,
}


def ucum_code(unit: str | None, code: str | None) -> str:
    """Prefer the UCUM code; fall back to the display unit via the alias table."""
    if code:
        return UNIT_ALIASES.get(code, code)
    if unit:
        if unit in UNIT_ALIASES:
            return UNIT_ALIASES[unit]
        return unit
    raise UnitError("quantity has neither unit nor code")


def convert(value: float, source: str, canonical: str) -> float:
    if source == canonical:
        return value
    if (source, canonical) == ("[degF]", "Cel"):
        return (value - 32.0) * 5.0 / 9.0
    factor = CONVERSIONS.get((source, canonical))
    if factor is None:
        raise UnitError(f"no conversion from {source!r} to {canonical!r}")
    return value * factor
