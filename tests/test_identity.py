from prospect.identity import UnsafeSourceUrl, canonicalize_url, opportunity_fingerprint, validate_public_url


def test_canonical_url_removes_tracking_noise_without_losing_identity() -> None:
    url = (
        "HTTPS://University.Example:443//phd/project/?utm_source=telegram&ref=board"
        "&project=trustworthy-ai#apply"
    )

    assert canonicalize_url(url) == (
        "https://university.example/phd/project?project=trustworthy-ai&ref=board"
    )


def test_fingerprint_matches_syndicated_versions_of_the_same_opportunity() -> None:
    university_record = opportunity_fingerprint(
        institution="Example University",
        title="PhD in Trustworthy AI",
        supervisor="Dr. Ada Example",
        deadline="2026-12-01",
    )
    job_board_record = opportunity_fingerprint(
        institution="  EXAMPLE   UNIVERSITY ",
        title="Ph.D. in trustworthy AI",
        supervisor="ada example",
        deadline="2026-12-01T23:59:00+01:00",
    )

    assert university_record == job_board_record


def test_source_url_rejects_private_network_targets() -> None:
    for unsafe_url in (
        "http://127.0.0.1/admin",
        "http://192.168.1.10/phd",
        "http://169.254.169.254/latest/meta-data",
        "http://localhost:5678/rest/credentials",
        "https://user:password@university.example/phd",
    ):
        try:
            validate_public_url(unsafe_url)
        except UnsafeSourceUrl:
            pass
        else:
            raise AssertionError(f"unsafe URL was accepted: {unsafe_url}")


def test_source_url_rejects_malformed_and_nonstandard_ports() -> None:
    for unsafe_url in (
        "https://university.example:not-a-port/phd",
        "https://university.example:8443/phd",
    ):
        try:
            validate_public_url(unsafe_url)
        except UnsafeSourceUrl:
            pass
        else:
            raise AssertionError(f"unsafe URL was accepted: {unsafe_url}")
