import json

import pytest

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


def test_seed_contacts_resolves_data_source_id_from_bootstrap_output(
    tmp_path, monkeypatch
) -> None:
    contacts_path = tmp_path / "contacts.json"
    contacts_path.write_text(json.dumps([{"name": "Pepa"}]))
    sources_path = tmp_path / "notion-data-sources.json"
    sources_path.write_text(json.dumps({"contacts": "contacts-ds-id"}))
    seen: dict[str, object] = {}

    def fake_seed(data_source_id, contacts, *, request):
        seen["data_source_id"] = data_source_id
        seen["contacts"] = contacts
        return ["page-1"]

    monkeypatch.setenv("NOTION_TOKEN", "test-token")
    monkeypatch.setattr("prospect.cli.seed_contacts", fake_seed)

    exit_code = main(
        ["seed-contacts", str(contacts_path), "--data-sources", str(sources_path)]
    )

    assert exit_code == 0
    assert seen["data_source_id"] == "contacts-ds-id"
    assert seen["contacts"] == [{"name": "Pepa"}]


def test_seed_contacts_requires_a_data_source_id(tmp_path) -> None:
    contacts_path = tmp_path / "contacts.json"
    contacts_path.write_text(json.dumps([{"name": "Pepa"}]))

    with pytest.raises(SystemExit):
        main(["seed-contacts", str(contacts_path)])
