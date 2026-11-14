#!/usr/bin/env python3
"""Unit tests for _hcl.py, the HCL block reader of the Terraform guard tests."""

import unittest

from _hcl import block, resource_body


BODY = '\n  bucket = "logs-${var.name}"\n  versioning_configuration {\n    status = "Enabled"\n  }\n'
SOURCE = f'resource "aws_s3_bucket_versioning" "logs" {{{BODY}}}\n\nresource "aws_s3_bucket" "logs" {{}}\n'


class HclTests(unittest.TestCase):
    def test_a_nested_block_reads_to_its_own_closing_brace(self):
        header = 'resource "aws_s3_bucket_versioning" "logs" {'
        self.assertEqual(block(SOURCE, header), f"{header}{BODY}}}")
        self.assertEqual(resource_body(SOURCE, "aws_s3_bucket_versioning", "logs"), BODY)
        # The retired `\n}` reader returned the whole outer dict here.
        source = 'SPECS = {\n    "a": {\n        "X": 1,\n    },\n    "b": {},\n}\n'
        self.assertEqual(block(source, '"a": {'), '"a": {\n        "X": 1,\n    }')

    def test_a_missing_header_raises(self):
        with self.assertRaises(ValueError):
            block(SOURCE, 'resource "aws_s3_bucket" "absent" {')
        with self.assertRaisesRegex(AssertionError, "missing aws_s3_bucket.absent"):
            resource_body(SOURCE, "aws_s3_bucket", "absent")

    def test_an_unterminated_block_raises(self):
        source = 'resource "aws_s3_bucket" "logs" {\n  a = {\n'
        with self.assertRaisesRegex(AssertionError, "unterminated"):
            block(source, 'resource "aws_s3_bucket" "logs" {')
        with self.assertRaisesRegex(AssertionError, "unterminated aws_s3_bucket.logs"):
            resource_body(source, "aws_s3_bucket", "logs")


if __name__ == "__main__":
    unittest.main()
