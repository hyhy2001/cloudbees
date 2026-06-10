from setuptools import setup, find_packages

setup(
    name="bee-cloudbees-cli",
    version="0.3.0",
    description="bee — CloudBees CLI + TUI tool for the terminal",
    packages=find_packages(include=["cb*"]),
    package_data={"": ["*.sql", "*.tcss"]},
    include_package_data=True,
    install_requires=[
        "click",
        "httpx",
        "cryptography",
        "textual",
        "rich",
    ],
    entry_points={
        "console_scripts": [
            "bee = cb.main:cli",
        ]
    },
)
