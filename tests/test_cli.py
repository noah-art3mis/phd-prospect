import json

from prospect.cli import main


def test_validate_command_prints_a_normalized_record(tmp_path, capsys) -> None:
    record_path = tmp_path / "record.json"
    record_path.write_text(
        json.dumps(
            {
                "title": "Trustworthy AI PhD",
                "source_url": "https://university.example/phd",
                "findings": {"funding": {"state": "not_stated", "value": None, "evidence": []}},
            }
        )
    )

    exit_code = main(["validate", str(record_path)])

    assert exit_code == 0
    assert json.loads(capsys.readouterr().out)["title"] == "Trustworthy AI PhD"
