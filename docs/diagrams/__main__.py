"""Regenerate every README diagram: python3 docs/diagrams"""
import hero
import host
import layers

for diagram in (hero, host, layers):
    diagram.main()
