import pytest

from mirage.commands.cli.builtin.gh.template import render_template


@pytest.mark.parametrize(
    "template,value,expected",
    [('{{range .}}{{if .ok}}{{.name}}{{else}}skip{{end}};{{end}}', [{
        'ok': True,
        'name': '雪'
    }, {
        'ok': False,
        'name': 'x'
    }], '雪;skip;'), ('{{range .}}x{{else}}empty{{end}}', [], 'empty'),
     ('{{pluck "name" . | join ", "}}', [{
         'name': 'one'
     }, {
         'name': 'two'
     }], 'one, two'),
     ('{{printf "%q %v %f" .name .ok .value}}', {
         'name': '雪',
         'ok': True,
         'value': 1.5
     }, '"雪" true 1.500000'),
     ('  {{- with .item -}}{{.name}}{{end}}  ', {
         'item': {
             'name': 'one'
         }
     }, 'one  ')])
def test_templates(template, value, expected):
    assert render_template(template, value) == expected


def test_unclosed_blocks_are_errors():
    with pytest.raises(ValueError, match="unexpected EOF"):
        render_template("{{range .}}", [])
