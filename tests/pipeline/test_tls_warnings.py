import warnings

from urllib3.exceptions import InsecureRequestWarning

from vpn_automation.pipeline.tls_warnings import suppress_insecure_request_warnings


def test_suppress_insecure_request_warnings_hides_intentional_unverified_https_warnings() -> None:
    with warnings.catch_warnings(record=True) as recorded:
        warnings.simplefilter("default")

        suppress_insecure_request_warnings()
        warnings.warn("expected warning from verify=False", InsecureRequestWarning)

    assert recorded == []
