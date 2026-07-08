"""Notion API payloads for Prospect's initial data sources."""

from __future__ import annotations

from typing import Any


def database_specs(parent_page_id: str) -> dict[str, dict[str, Any]]:
    """Return database creation payloads for Notion API version 2026-03-11."""

    return {
        "opportunities": _database(
            parent_page_id,
            "Prospect – Opportunities",
            {
                "Name": {"title": {}},
                "Type": _select(
                    "Advertised project",
                    "Doctoral programme",
                    "CDT or cohort",
                    "Fellowship",
                    "Scholarship",
                    "Self-proposed route",
                ),
                "Institution": {"rich_text": {}},
                "Department or lab": {"rich_text": {}},
                "Country": {"rich_text": {}},
                "City": {"rich_text": {}},
                "Programme": {"rich_text": {}},
                "Start date": {"date": {}},
                "Duration": {"rich_text": {}},
                "Advert ID": {"rich_text": {}},
                "Application stage": _select(
                    "Inbox",
                    "Researching",
                    "Eligible",
                    "Shortlisted",
                    "Supervisor outreach",
                    "Preparing application",
                    "Waiting for references",
                    "Ready to submit",
                    "Submitted",
                    "Interview",
                    "Decision pending",
                    "Offer",
                    "Accepted",
                    "Rejected",
                    "Withdrawn",
                    "Ineligible",
                    "Expired",
                    "Declined",
                ),
                "Opportunity status": _select("Open", "Closed", "Withdrawn", "Unknown"),
                "Priority": _select("High", "Medium", "Low"),
                "Canonical URL": {"url": {}},
                "Source URL": {"url": {}},
                "Application URL": {"url": {}},
                "Fingerprint": {"rich_text": {}},
                "Last checked": {"date": {}},
                "Confirmed": {"checkbox": {}},
                "Supervisor contact required": {"checkbox": {}},
                "Funding status": _select(
                    "Fully funded", "Partially funded", "Salaried", "Self-funded", "Unclear"
                ),
                "Stipend or salary": {"number": {"format": "number"}},
                "Currency": _select("EUR", "GBP", "USD", "CAD", "AUD", "CHF", "Other"),
                "Tuition coverage": _select("Full", "Home only", "Partial", "None", "Unclear"),
                "Supervisors": {"rich_text": {}},
                "Research topics": {"rich_text": {}},
                "Summary": {"rich_text": {}},
                "Evidence": {"rich_text": {}},
            },
        ),
        "deadlines": _database(
            parent_page_id,
            "Prospect – Deadlines",
            {
                "Name": {"title": {}},
                "Type": _select(
                    "Supervisor contact",
                    "Expression of interest",
                    "Programme application",
                    "Funding application",
                    "Reference request",
                    "Recommender submission",
                    "Supporting documents",
                    "Certified documents",
                    "Interview",
                    "Expected decision",
                    "Offer acceptance",
                    "Enrolment",
                    "Visa",
                    "Start date",
                ),
                "Due": {"date": {}},
                "Timezone": {"rich_text": {}},
                "Rolling": {"checkbox": {}},
                "Verified": {"checkbox": {}},
                "Version": {"number": {"format": "number"}},
                "Reminder offsets": _multi_select("30", "14", "7", "1"),
                "Evidence URL": {"url": {}},
                "Evidence excerpt": {"rich_text": {}},
                "Reminder keys sent": {"rich_text": {}},
            },
        ),
        "contacts": _database(
            parent_page_id,
            "Prospect – Contacts",
            {
                "Name": {"title": {}},
                "Role": _select(
                    "Supervisor",
                    "Co-supervisor",
                    "Programme coordinator",
                    "Administrator",
                    "Current student",
                    "Referee",
                    "Other",
                ),
                "Institution or lab": {"rich_text": {}},
                "Research topics": {"rich_text": {}},
                "Email": {"email": {}},
                "Profile URL": {"url": {}},
                "Last contact": {"date": {}},
                "Follow-up": {"date": {}},
                "Response status": _select("Not contacted", "Waiting", "Replied", "Unavailable"),
                "Notes": {"rich_text": {}},
            },
        ),
        "activities": _database(
            parent_page_id,
            "Prospect – Activities",
            {
                "Name": {"title": {}},
                "Type": _select(
                    "Research",
                    "Outreach",
                    "Document",
                    "Application",
                    "Reference",
                    "Interview",
                    "Follow-up",
                    "Decision",
                    "Other",
                ),
                "Due": {"date": {}},
                "Completed": {"checkbox": {}},
                "Completed at": {"date": {}},
                "Result": {"rich_text": {}},
                "Notes": {"rich_text": {}},
            },
        ),
        "documents": _database(
            parent_page_id,
            "Prospect – Documents",
            {
                "Name": {"title": {}},
                "Type": _select(
                    "CV",
                    "Research proposal",
                    "Statement of purpose",
                    "Personal statement",
                    "Transcript",
                    "Certificate",
                    "Language evidence",
                    "Writing sample",
                    "Publication",
                    "Portfolio",
                    "Other",
                ),
                "Status": _select("Missing", "Drafting", "Review", "Ready", "Submitted"),
                "Version": {"number": {"format": "number"}},
                "File": {"files": {}},
                "Submitted at": {"date": {}},
                "Portal limit": {"rich_text": {}},
                "Notes": {"rich_text": {}},
            },
        ),
    }


def relation_updates(data_source_ids: dict[str, str]) -> dict[str, dict[str, Any]]:
    """Return relation properties after all five data sources exist."""

    opportunity_id = data_source_ids["opportunities"]
    return {
        collection: {
            "properties": {
                "Opportunity": {
                    "relation": {
                        "data_source_id": opportunity_id,
                        "dual_property": {},
                    }
                }
            }
        }
        for collection in ("deadlines", "contacts", "activities", "documents")
    }


def _database(parent_page_id: str, name: str, properties: dict[str, Any]) -> dict[str, Any]:
    return {
        "parent": {"type": "page_id", "page_id": parent_page_id},
        "title": [{"type": "text", "text": {"content": name}}],
        "is_inline": False,
        "initial_data_source": {"properties": properties},
    }


def _select(*options: str) -> dict[str, Any]:
    return {"select": {"options": [{"name": option} for option in options]}}


def _multi_select(*options: str) -> dict[str, Any]:
    return {"multi_select": {"options": [{"name": option} for option in options]}}
