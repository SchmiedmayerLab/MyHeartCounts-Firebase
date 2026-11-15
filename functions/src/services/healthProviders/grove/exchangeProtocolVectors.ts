// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

// Subset of the conformance vectors in grove-fhir 0.8.0
// `catalog/exchange-protocol.json` → `testVectors`, limited to the identity
// kinds this backend produces (provider-*, device-snapshot, record-version) and
// to vectors that do not depend on preserving JSON number lexemes. Test-only data.
/* eslint-disable */

export const exchangeProtocolTestVectors = {
  "keyHex": "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "keyId": "test-key",
  "epoch": "1",
  "identitySystems": [
    {
      "identityKind": "provider-record",
      "system": "https://study.example.org/fhir/NamingSystem/grove-provider-record-v0/test-key/1"
    },
    {
      "identityKind": "provider-output",
      "system": "https://study.example.org/fhir/NamingSystem/grove-provider-output-v0/test-key/1"
    },
    {
      "identityKind": "provider-artifact",
      "system": "https://study.example.org/fhir/NamingSystem/grove-provider-artifact-v0/test-key/1"
    },
    {
      "identityKind": "device-snapshot",
      "system": "https://study.example.org/fhir/NamingSystem/grove-device-snapshot-v0/test-key/1"
    },
    {
      "identityKind": "record-version",
      "system": "https://study.example.org/fhir/NamingSystem/grove-record-version-v0/test-key/1"
    }
  ],
  "identities": [
    {
      "id": "provider-account-complete-pair",
      "identityKind": "provider-record",
      "components": [
        "withings",
        "measure",
        "https://accounts.example.org",
        "patient|α",
        "17348211"
      ],
      "value": "v0:test-key:1:qfmx1ajnVg_rNE8qiL_hIAWI8GtbVpRtf6T2RWREezM"
    },
    {
      "id": "provider-output-domain-separated",
      "identityKind": "provider-output",
      "components": [
        "withings",
        "getmeas:9+10",
        "https://accounts.example.org",
        "patient|α",
        "17348211",
        "blood-pressure-panel",
        "single"
      ],
      "value": "v0:test-key:1:mum-FTSsu6Kv_QBFNSjcFuznTp5C6D3QnrQ6iwm23Ec"
    },
    {
      "id": "provider-artifact-domain-separated",
      "identityKind": "provider-artifact",
      "components": [
        "google-health-api",
        "heart-rate",
        "https://accounts.example.org",
        "patient|α",
        "recording-001",
        "provider-recording",
        "0"
      ],
      "value": "v0:test-key:1:0LxvhsWmRngwxPPMqWk7--4qTN8Wa1j-oTbGuMCCgrA"
    },
    {
      "id": "device-snapshot-application-content",
      "identityKind": "device-snapshot",
      "components": [
        "https://study.example.org/fhir/identifiers/participant",
        "participant-001",
        "application",
        "4pqk-W06e5OEkG9iG862Vgry02ywK4iomj_6BqrTZG4"
      ],
      "value": "v0:test-key:1:OKD7MHwL4JGF9Y-_i_qJGKK36zobAOlJrBNAAakQcro"
    },
    {
      "id": "record-version-heart-rate-72",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY",
        "zQn6qLSfmufltslE_5oFb25RNjY1-XN5s547r43EumY"
      ],
      "value": "v0:test-key:1:xjbzwZqYyBE1boHxzOoS09iLXEMrvo0o8dpxtlwPQhE"
    },
    {
      "id": "record-version-heart-rate-72-0",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY",
        "1VvPJMtUBZEzD8DX5WFNjMr8pMVyKERNzlUyAKQLpuk"
      ],
      "value": "v0:test-key:1:z2SXdSGr63iLne5oavwMibQClshhTEABve_JEZLljCo"
    },
    {
      "id": "receiver-lifecycle-multi-v3-record-version-3",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY",
        "qLuPgG-qb3Djg6CxJEurlNNk7M2haatvWuCQVn6ZAVM"
      ],
      "value": "v0:test-key:1:-0FOFDNefG_F1Kijariy5UrCFGYN10hKiIu4RyF_VWA"
    },
    {
      "id": "receiver-lifecycle-other-writer-record-version-3",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY",
        "NBpFl1FvTAFIMI86cCgE1dtZGzkU_EGBlO1aa6kmUwY"
      ],
      "value": "v0:test-key:1:52Q6md0UZ0wG5BDeLVhz-LdbDVfqBARUXBvV0fFj_8Y"
    },
    {
      "id": "receiver-lifecycle-lexeme-retry-record-version-3",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY",
        "bKUy3TUh47p2U1gNSAVMyfEhr460TjgIiOHpPJsH7t4"
      ],
      "value": "v0:test-key:1:57rOqeDd5AVmNxQma4fZXGMnlb8zrZrHSCQKb0TMe9M"
    },
    {
      "id": "receiver-lifecycle-reconverted-record-version-3",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY",
        "mzpjr4IQzHNquIMetMCVLA2eZFAyoQ0MwFm2zlqkdSU"
      ],
      "value": "v0:test-key:1:62Xc65RPZmki7UB7iYw2CT4BMvNH9Gt8WUXsSwkl2P8"
    },
    {
      "id": "receiver-lifecycle-equal-version-later-recorded-record-version-3",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY",
        "744fvjlVTE85v-DOhtmIoKT4PvjiuBPn4qzuCmuMh-Y"
      ],
      "value": "v0:test-key:1:FFtAoENlRmglBM3sGXPCP3C-SiYzk5KqUROAxK7sjDM"
    },
    {
      "id": "mobile-exchange-exchange-bundle-application-device-snapshot-1",
      "identityKind": "device-snapshot",
      "components": [
        "https://study.example.org/fhir/identifiers/participant",
        "participant-001",
        "application",
        "wAZ92PxGmx1A9BciamqWIUn685NqcdVl1IFrw1ULGtY"
      ],
      "value": "v0:test-key:1:Gm8_MD0ZNlH6vNBsj8s11GgVDJGHMUROX1amyK00jFs"
    },
    {
      "id": "receiver-lifecycle-missing-order-record-version-3",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY",
        "AZ1-Ll5twnuDmHIw12OmEXjnHpu3ceSNT7oeVWU-BCA"
      ],
      "value": "v0:test-key:1:I7oI-P0smVTBW-1WvmgeT2UR9I2UDPNuHasdnxNOR3U"
    },
    {
      "id": "receiver-lifecycle-original-record-version-3",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY",
        "KuOyMG30Y7RYgC5U_Sz404F0ejAoM-3_yvVLpC5vOtM"
      ],
      "value": "v0:test-key:1:I8TcW3NvmUyaAVzIhPiY7oo0EA5uOn979Nhuixy0STo"
    },
    {
      "id": "receiver-lifecycle-multi-v1-record-version-3",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY",
        "Y_1wxNjQ9jHtgFZbJqi-AEnAeIoEvxPw8GyIgEmscX0"
      ],
      "value": "v0:test-key:1:NQSJUQLiSfB8UFUm-DN4F3yJKBQJk01Hnjr1ZuMCDGc"
    },
    {
      "id": "receiver-lifecycle-equal-version-reconversion-record-version-3",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY",
        "pS0YIbjWtIZez1pZGdvMS5PqhnBl2K3ZNbmP7XcPUf8"
      ],
      "value": "v0:test-key:1:NeQ-uDYACuiF9yijNydPYDDtkK6QJiTytLzmR2Lliw4"
    },
    {
      "id": "receiver-lifecycle-unordered-a-record-version-3",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY",
        "kntrWeMBeWiu2_fCLLe23RzR48CVFXwMMa924k0q9Sc"
      ],
      "value": "v0:test-key:1:PaxxOvAs91EJRAKUFZMqjzU4GlgXld9rdRf_xswYpWw"
    },
    {
      "id": "receiver-lifecycle-mixed-admission-record-version-6",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:TE47APXmta6xbmGufkf8LBv8q3aPR4NDn9bltP7vEn4",
        "Pmn2QyxL5l7Eb_If-eXylkDcOIpcnAsm5kmqExhddJs"
      ],
      "value": "v0:test-key:1:TQHdUGNfFyyNL6tbhoyEdOGuFaXmRWlGX71Rz1hMJno"
    },
    {
      "id": "receiver-lifecycle-changed-source-record-record-version-3",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:WssrtI7oYzcgG0mFxlitvSznCx4esKSDEbK-bOUQpTk",
        "MzWAtV5KZyJ8J1KPeA2adcE5BZRimVzPm1QIGt9sKW4"
      ],
      "value": "v0:test-key:1:VSrL_eGaokv2Z16RAt1_kaSSYjvHh3Ks8EYCNsEUTTw"
    },
    {
      "id": "mobile-exchange-exchange-bundle-record-version-6",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:Ce4AD2kT5yierXkx5QJNFu7d8qqaSSQOCKGFeYpu2M0",
        "k_a3SM53Lfq9R6jgYDhN8EcuIp118I4xyADWn9Da32Q"
      ],
      "value": "v0:test-key:1:a_uGh_911xHmIsPSEu0p147dT2I3rtr1uWWiKrKudsY"
    },
    {
      "id": "study-attribution-policy-negative-subject-mismatch-record-version-3",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY",
        "xpke1ZbN6GtUhlvQw-liTCkamThH5hpn7JpecKRitFk"
      ],
      "value": "v0:test-key:1:bPyV3lwtPox84i-1jtri_UyMis2PtZvmo0mmq9XQrn0"
    },
    {
      "id": "mobile-exchange-exchange-bundle-record-version-3",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY",
        "JH6LXyyA4k6l-QgmWSzIfJwJ-DBpo4RbUFW2qUHuVKg"
      ],
      "value": "v0:test-key:1:cd-Pae2AS1sITLmwdpC9D0uOuEfWCn58_X4d6EA8qtY"
    },
    {
      "id": "study-attribution-context-two-studies-record-version-3",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY",
        "0EZV-zNTRRH--o35_kB9Qu04K3nwAGbz9eHB6t89KEI"
      ],
      "value": "v0:test-key:1:chouEwId0FQ039PjSGtiQ7t0vFrAhI7ME1uUfyPfq6k"
    },
    {
      "id": "receiver-lifecycle-corrected-record-version-3",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY",
        "xZLNI23x_jYBVkOeyDOLfDJ8EmBpxRUS2xkEyyvGoY8"
      ],
      "value": "v0:test-key:1:coyKAaPUs9QdAHkecsNE5g5dUzACb3FAv_vLQDiyf8w"
    },
    {
      "id": "receiver-lifecycle-unordered-b-record-version-3",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY",
        "gOpSgrZM-UHxCMdilzByhbRB8Ir6vPGBIDoj8C6hBDk"
      ],
      "value": "v0:test-key:1:rN1qE7AnoFKaJhnAPooL9VFq1Uh1DGDxT3GzG6eJF44"
    },
    {
      "id": "receiver-lifecycle-multi-v2-record-version-3",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY",
        "2CEqHmkIwHuLwArerxZdW5DdW3b9z8ZFtr-6fgR6GkY"
      ],
      "value": "v0:test-key:1:tTobsrtpfc56ceW0b3bMJe-3KAOSYLnENUzDpgykFec"
    },
    {
      "id": "receiver-lifecycle-pending-record-version-3",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY",
        "vAanUPEOfJhjYfI7QQwSWqFR6LWnNzp_VQy1dK2Pwm0"
      ],
      "value": "v0:test-key:1:wowwu5_jxYykm0KTPrF1NVtu0asK9xWjoapLoGOXzyw"
    },
    {
      "id": "receiver-lifecycle-equal-version-equal-recorded-record-version-3",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY",
        "1W1vTIW6x7BzWHmNt5_UdhvVvQZkjkzN6xPYOtdvGVs"
      ],
      "value": "v0:test-key:1:xXRvK4HIFPEXVYyBgM90FNbIPDZfsMNsoBkjQosbp8o"
    },
    {
      "id": "questionnaire-extraction-host-snapshot",
      "identityKind": "device-snapshot",
      "components": [
        "https://example.org/research/participant-id",
        "participant-001",
        "host",
        "KO2_OD0upXDBqxHQkB_z9wUQbBQla-3q0BW6ZCVXdvU"
      ],
      "value": "v0:test-key:1:BJ68B1Ln-JzOKPDWOevEmnjQNsX0BheIosEdSGgRV1A"
    },
    {
      "id": "questionnaire-extraction-application-snapshot",
      "identityKind": "device-snapshot",
      "components": [
        "https://example.org/research/participant-id",
        "participant-001",
        "application",
        "LEXpeoVjEJDN7-MtE7yu81zeJoxB5dk2RWvsbqGc00w"
      ],
      "value": "v0:test-key:1:XoZPVj1lObWj4ma3jFPQvjayZF1v4Piu9mnFu-xwx_0"
    },
    {
      "id": "questionnaire-extraction-bundle-application-snapshot",
      "identityKind": "device-snapshot",
      "components": [
        "https://example.org/research/participant-id",
        "participant-001",
        "application",
        "fW5oESnyMKwYu_AtB-FkvKLkKAM7mbdsv0SMHZiBS7s"
      ],
      "value": "v0:test-key:1:fZBQIWIeM0SUmHvsH68yGnBNNNz_jdJ9SFkWOMGuxKw"
    },
    {
      "id": "questionnaire-extraction-record-version",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:7_7dmqTFxPH01QGTycmp8nIPty7WwphH2X0ZaV-p3wk",
        "81FfElnoVKcSLq7w3HBsGRXNiMN9wwZjNofjWo_VLnc"
      ],
      "value": "v0:test-key:1:RIiSEVoX9fCoWyNMZvL3QAPxmelpxzePPzRbQOfPtb0"
    }
  ],
  "invalidIdentities": [
    {
      "id": "leading-zero-part-index",
      "identityKind": "provider-artifact",
      "components": [
        "google-health-api",
        "heart-rate",
        "https://accounts.example.org",
        "patient|α",
        "recording-001",
        "provider-recording",
        "01"
      ],
      "expectedError": "non-canonical-part-index"
    },
    {
      "id": "padded-record-content-digest",
      "identityKind": "record-version",
      "components": [
        "https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1",
        "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY",
        "zQn6qLSfmufltslE_5oFb25RNjY1-XN5s547r43EumY="
      ],
      "expectedError": "non-canonical-digest"
    },
    {
      "id": "truncated-content-digest",
      "identityKind": "device-snapshot",
      "components": [
        "https://study.example.org/fhir/identifiers/participant",
        "participant-001",
        "application",
        "4pqk-W06e5OEkG9iG862Vgry02ywK4iomj_6BqrTZG"
      ],
      "expectedError": "non-canonical-digest"
    }
  ],
  "fullUrls": [
    {
      "id": "unicode-value-and-escaped-system",
      "system": "https://xn--fsq.example/%E8%AD%98%E5%88%A5%E5%AD%90",
      "value": "café|東京",
      "fullUrl": "urn:uuid:d35e4203-71f6-595c-bd1b-306b8414974e"
    },
    {
      "id": "record-version-heart-rate-72",
      "system": "https://study.example.org/fhir/NamingSystem/grove-record-version-v0/test-key/1",
      "value": "v0:test-key:1:xjbzwZqYyBE1boHxzOoS09iLXEMrvo0o8dpxtlwPQhE",
      "fullUrl": "urn:uuid:af53df9f-24e4-5773-9301-a3887fdf2f57"
    },
    {
      "id": "record-version-heart-rate-72-0",
      "system": "https://study.example.org/fhir/NamingSystem/grove-record-version-v0/test-key/1",
      "value": "v0:test-key:1:z2SXdSGr63iLne5oavwMibQClshhTEABve_JEZLljCo",
      "fullUrl": "urn:uuid:b0624977-9c3f-574d-82ae-112f578bae1a"
    },
    {
      "id": "record-retraction-heart-rate",
      "system": "https://study.example.org/fhir/NamingSystem/grove-record-retraction-v0/test-key/1",
      "value": "v0:test-key:1:0JJ96w-JxTpK7Bb-910L_61f3KJdI8Cr4eSGTpJ7L7o",
      "fullUrl": "urn:uuid:03e766bb-9cc6-51b2-b67e-e8902e01513f"
    }
  ],
  "canonicalJson": [
    {
      "id": "members-and-escapes",
      "input": "{\"b\":\"é\\/\",\"c\":\"ｚ😀\",\"a\":\"q\\\"\\\\\\u0001\\t\",\"A\":2}",
      "canonical": "{\"A\":2,\"a\":\"q\\\"\\\\\\u0001\\t\",\"b\":\"é/\",\"c\":\"ｚ😀\"}",
      "sha256": "79e56476cbdc80332cc8dc46c5d24578aec04aad5ffc94427e7d8a5346c45e94"
    }
  ],
  "recordContents": [
    {
      "id": "heart-rate-72",
      "provenance": "{\"resourceType\":\"Provenance\",\"id\":\"not-in-the-digest\",\"meta\":{\"profile\":[\"https://grovealliance.org/fhir/mobile/StructureDefinition/grove-mobile-conversion-provenance\"]},\"extension\":[{\"url\":\"https://grovealliance.org/fhir/mobile/StructureDefinition/grove-record-version\",\"valueIdentifier\":{\"system\":\"https://study.example.org/fhir/NamingSystem/grove-record-version-v0/test-key/1\",\"type\":{\"coding\":[{\"code\":\"record-version\",\"system\":\"https://grovealliance.org/fhir/mobile/CodeSystem/grove-identifier-role\"}]},\"value\":\"v0:test-key:1:xjbzwZqYyBE1boHxzOoS09iLXEMrvo0o8dpxtlwPQhE\"}}],\"activity\":{\"coding\":[{\"code\":\"transform\",\"system\":\"http://terminology.hl7.org/CodeSystem/iso-21089-lifecycle\"}]},\"agent\":[{\"type\":{\"coding\":[{\"code\":\"assembler\",\"system\":\"http://terminology.hl7.org/CodeSystem/provenance-participant-type\"}]},\"who\":{\"reference\":\"urn:uuid:aef62dba-db7e-5a99-a854-3b5ec312312f\"}}],\"entity\":[{\"role\":\"source\",\"what\":{\"identifier\":{\"system\":\"https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1\",\"type\":{\"coding\":[{\"code\":\"source-record\",\"system\":\"https://grovealliance.org/fhir/mobile/CodeSystem/grove-identifier-role\"}]},\"value\":\"v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY\"}}}],\"occurredDateTime\":\"2026-08-20T10:30:02-07:00\",\"recorded\":\"2026-08-20T17:30:02Z\",\"target\":[{\"reference\":\"urn:uuid:a9b76bbc-f523-5ef4-9919-813ec70553e5\"}]}",
      "outputs": [
        "{\"code\":{\"coding\":[{\"code\":\"8867-4\",\"system\":\"http://loinc.org\"}]},\"effectiveDateTime\":\"2026-08-20T08:30:00.251-07:00\",\"identifier\":[{\"system\":\"https://study.example.org/fhir/NamingSystem/grove-source-record-v0/test-key/1\",\"type\":{\"coding\":[{\"code\":\"source-record\",\"system\":\"https://grovealliance.org/fhir/mobile/CodeSystem/grove-identifier-role\"}]},\"value\":\"v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY\"},{\"system\":\"https://study.example.org/fhir/NamingSystem/grove-source-output-v0/test-key/1\",\"type\":{\"coding\":[{\"code\":\"source-output\",\"system\":\"https://grovealliance.org/fhir/mobile/CodeSystem/grove-identifier-role\"}]},\"value\":\"v0:test-key:1:PPULnf0LKpASjIj8mU5TKafPKig_oqWND3_dHFShGd8\"}],\"meta\":{\"profile\":[\"https://grovealliance.org/fhir/mobile/StructureDefinition/grove-mobile-heart-rate\"]},\"resourceType\":\"Observation\",\"status\":\"final\",\"subject\":{\"identifier\":{\"system\":\"https://study.example.org/fhir/identifiers/participant\",\"value\":\"participant-001\"},\"type\":\"Patient\"},\"valueQuantity\":{\"code\":\"/min\",\"system\":\"http://unitsofmeasure.org\",\"unit\":\"beats/minute\",\"value\":72}}"
      ],
      "recordContentDigest": "zQn6qLSfmufltslE_5oFb25RNjY1-XN5s547r43EumY"
    }
  ]
};
