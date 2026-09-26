# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

import pyarrow as pa
import pytest

from mhc_export.transform.category_values import CategoryValueError, category_value
from mhc_export.transform.specs import COMMON_COLUMNS, default_registry
from mhc_export.transform.units import UnitError, convert, ucum_code


def test_ucum_code_prefers_code_and_aliases_unit_text() -> None:
    assert ucum_code("beats/minute", "/min") == "/min"
    assert ucum_code("steps", None) == "{steps}"
    assert ucum_code("flights", None) == "{flights}"
    assert ucum_code("lbs", "[lb_av]") == "[lb_av]"
    assert ucum_code("kg/m^2", "kg/m2") == "kg/m2"
    assert ucum_code("weird", None) == "weird"
    with pytest.raises(UnitError):
        ucum_code(None, None)


def test_convert() -> None:
    assert convert(5, "kg", "kg") == 5
    assert convert(166.449, "[lb_av]", "kg") == pytest.approx(75.5, abs=0.01)
    assert convert(70, "[in_i]", "cm") == pytest.approx(177.8)
    assert convert(212, "[degF]", "Cel") == pytest.approx(100.0)
    assert convert(1, "mmol/L", "mg/dL") == pytest.approx(18.0182)
    with pytest.raises(UnitError):
        convert(1, "furlong", "m")


def test_category_values() -> None:
    assert category_value("HKCategoryTypeIdentifierSleepAnalysis", "3") == ("asleepCore", "light")
    assert category_value("HKCategoryTypeIdentifierSleepAnalysis", 5) == ("asleepREM", "rem")
    assert category_value("HKCategoryTypeIdentifierAppleStandHour", 0) == ("stood", "stood")
    assert category_value("HKCategoryTypeIdentifierLowHeartRateEvent", None) == ("notApplicable", "occurred")
    with pytest.raises(CategoryValueError):
        category_value("HKCategoryTypeIdentifierSleepAnalysis", 9)
    with pytest.raises(CategoryValueError):
        category_value("HKCategoryTypeIdentifierSleepAnalysis", None)
    with pytest.raises(CategoryValueError):
        category_value("HKQuantityTypeIdentifierHeartRate", 1)


def test_registry_specs() -> None:
    reg = default_registry()
    hr = reg.get("HKQuantityTypeIdentifierHeartRate")
    assert hr is not None and hr.exportable and hr.unit == "/min" and hr.measurement_id == "heart-rate"
    assert hr.arrow_schema.field("value").type == pa.float64()
    assert hr.arrow_schema.field("effective_start").type == pa.timestamp("us", tz="UTC")
    assert "motion_context" in hr.column_names
    sleep = reg.get("HKCategoryTypeIdentifierSleepAnalysis")
    assert sleep is not None and sleep.exportable and sleep.allowed_values and "light" in sleep.allowed_values
    steps = reg.get("HKQuantityTypeIdentifierStepCount")
    assert steps is not None and steps.integer_only and steps.unit == "{steps}" and steps.effective == "Period"
    ecg = reg.get("HKDataTypeIdentifierElectrocardiogram")
    assert ecg is not None and not ecg.exportable
    assert reg.get("HKQuantityTypeIdentifierBloodPressureSystolic").exportable is False
    assert reg.get("nope") is None
    assert len(reg.exportable_types()) > 150
    names = [c[0] for c in COMMON_COLUMNS]
    assert names[:3] == ["sample_id", "source_record_id", "participant_id"] and names[-1] == "export_seq"


def test_all_exportable_quantity_types_have_a_unit() -> None:
    reg = default_registry()
    for t in reg.exportable_types():
        spec = reg.get(t)
        assert spec is not None
        if spec.value_kind == "quantity":
            assert spec.unit, t
        else:
            assert spec.allowed_values, t


def test_bmi_is_exportable_via_standard_profile() -> None:
    bmi = default_registry().get("HKQuantityTypeIdentifierBodyMassIndex")
    assert bmi is not None and bmi.exportable and bmi.unit == "kg/m2" and bmi.measurement_id == "body-mass-index"
