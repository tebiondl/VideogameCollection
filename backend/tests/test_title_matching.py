import unittest

from backend.app.services.title_matching import compare_titles, parse_title


class TitleMatchingTests(unittest.TestCase):
    def test_equivalent_installment_styles_match(self):
        for first, second in (
            ('Trails of Cold Steel II', 'Trails of Cold Steel 2'),
            ('Etrian Odyssey Two', 'Etrian Odyssey II'),
            ('Half-Life 2: Episode One', 'Half Life II Episode I'),
        ):
            with self.subTest(first=first, second=second):
                result = compare_titles(first, second)
                self.assertTrue(result.compatible)
                self.assertTrue(result.automatic)
                self.assertGreaterEqual(result.score, .98)

    def test_different_installments_are_a_hard_mismatch(self):
        for first, second in (
            ('Trails of Cold Steel', 'Trails of Cold Steel II'),
            ('Trails of Cold Steel II', 'Trails of Cold Steel III'),
            ('Borderlands 2', 'Borderlands 3'),
            ('Portal', 'Portal 2'),
            ('Half-Life 2', 'Half-Life 2: Episode One'),
            ('Trails of Cold Steel II: The Erebonian Civil War', 'Trails of Cold Steel III: The Erebonian Civil War'),
            ('One Piece Pirate Warriors 3', 'One Piece Pirate Warriors 4'),
            ('F1 2023', 'F1 2024'),
        ):
            with self.subTest(first=first, second=second):
                result = compare_titles(first, second)
                self.assertFalse(result.compatible)
                self.assertEqual(result.relation, 'different_installment')
                self.assertEqual(result.score, 0)

    def test_implicit_first_installment_requires_review(self):
        result = compare_titles('Trails of Cold Steel', 'Trails of Cold Steel I')
        self.assertTrue(result.compatible)
        self.assertFalse(result.automatic)
        self.assertEqual(result.relation, 'implicit_first_installment')

        alias = compare_titles('Skyrim', 'The Elder Scrolls V: Skyrim')
        self.assertTrue(alias.compatible)
        self.assertFalse(alias.automatic)
        self.assertEqual(alias.relation, 'ambiguous_numbered_alias')

    def test_number_words_in_names_are_not_always_installments(self):
        parsed = parse_title('One Piece Pirate Warriors 3')
        self.assertEqual(parsed.installments, ('3',))
        self.assertIn('one', parsed.base)
        self.assertEqual(parse_title('I Am Setsuna').installments, ())
        self.assertEqual(parse_title('Trails of Cold Steel II: A New Chapter').installments, ('2',))

    def test_parenthesized_year_is_an_edition_but_annual_title_year_is_identity(self):
        self.assertTrue(compare_titles('Final Fantasy VII', 'Final Fantasy VII (2013)').automatic)
        self.assertFalse(compare_titles('Football Manager 2023', 'Football Manager 2024').compatible)

    def test_remake_and_content_variants_do_not_merge_with_the_original(self):
        for other in ('Final Fantasy VII Remake', 'Final Fantasy VII Demo', 'Final Fantasy VII Soundtrack'):
            with self.subTest(other=other):
                self.assertFalse(compare_titles('Final Fantasy VII', other).compatible)

    def test_regular_editions_remain_reviewable_but_not_automatic(self):
        result = compare_titles('Skyrim', 'Skyrim Special Edition')
        self.assertTrue(result.compatible)
        self.assertFalse(result.automatic)
        self.assertEqual(result.relation, 'different_edition')


if __name__ == '__main__':
    unittest.main()
